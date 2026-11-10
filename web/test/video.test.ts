import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openAsBlob, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCaption, parseCaption } from '../src/engine/caption';
import { downloadOriginals, zipOf } from '../src/engine/download';
import { hashBlob } from '../src/engine/media';
import { answerWorker, openVideo, type WorkerRequest } from '../src/engine/mediaWorker';
import { BlockCache, locateRange, planPieces, TELEGRAM_SPLIT, wholeName } from '../src/engine/pieces';
import { OriginalMissingError, type PutPhotoInput } from '../src/engine/types';
import { blobBytes, Device, makeJpeg, makeMp4, sha256 } from './helpers';

const SESSION = 'fake:+15550000001';
const CTX = { session: SESSION, library: { channelId: encodeURIComponent(SESSION), accessHash: '0' } };
/** Small enough to run in memory. The single-file limit differs from the piece size, as it does for real. */
const SPLIT = { maxSingleBytes: 5000, pieceBytes: 3000 };
const GIB = 1024 ** 3;

const joined = async (stream: AsyncIterable<Uint8Array>) => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
};

/** The bytes from `start` to `end`, asking as many times as it takes, the way the worker does. */
async function readAll(d: Device, id: number, start: number, end: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (let at = start; at < end; ) {
    const bytes = await d.engine.readRange(id, at, end);
    expect(bytes.length).toBeGreaterThan(0);
    chunks.push(bytes);
    at += bytes.length;
  }
  return new Uint8Array(Buffer.concat(chunks));
}

describe('planning the pieces', () => {
  it('leaves anything Telegram can take whole as a single piece', () => {
    expect(planPieces(TELEGRAM_SPLIT.maxSingleBytes, TELEGRAM_SPLIT)).toEqual([{ start: 0, end: TELEGRAM_SPLIT.maxSingleBytes }]);
  });

  it('splits one byte past the limit, with no piece over it and nothing missed or repeated', () => {
    const size = TELEGRAM_SPLIT.maxSingleBytes + 1;
    const plan = planPieces(size, TELEGRAM_SPLIT);
    expect(plan.length).toBeGreaterThan(1);
    expect(plan[0]!.start).toBe(0);
    expect(plan.at(-1)!.end).toBe(size);
    plan.forEach((piece, i) => {
      expect(piece.end - piece.start).toBeLessThanOrEqual(TELEGRAM_SPLIT.maxSingleBytes);
      if (i > 0) expect(piece.start).toBe(plan[i - 1]!.end);
    });
  });

  it('copes with a file far larger than any one number of bytes a 32-bit system could hold', () => {
    const plan = planPieces(50 * GIB + 1, TELEGRAM_SPLIT);
    expect(plan).toHaveLength(51);
    expect(plan.at(-1)).toEqual({ start: 50 * GIB, end: 50 * GIB + 1 });
  });

  it('gets the name back from a numbered piece, leaving other numbers alone', () => {
    expect(wholeName('clip.2024.mp4.012')).toBe('clip.2024.mp4');
    expect(wholeName('clip.mp4.1000')).toBe('clip.mp4');
  });
});

describe('finding where a read falls', () => {
  const pieces = [{ messageId: 1, size: GIB }, { messageId: 2, size: GIB }, { messageId: 3, size: 10 }];

  it('translates a position in the file to a position in its piece', () => {
    expect(locateRange(pieces, GIB + 5, GIB + 9)).toEqual({ messageId: 2, pieceSize: GIB, start: 5, end: 9 });
  });

  it('stops at the end of a piece, so the rest is asked for from the next one', () => {
    expect(locateRange(pieces, GIB - 5, GIB + 5)).toEqual({ messageId: 1, pieceSize: GIB, start: GIB - 5, end: GIB });
    expect(locateRange(pieces, GIB, GIB + 5)).toEqual({ messageId: 2, pieceSize: GIB, start: 0, end: 5 });
  });

  it('asks for no more than a few of Telegram\'s blocks at once, stopping where one ends', () => {
    const block = 512 * 1024;
    expect(locateRange(pieces, 0, GIB)?.end).toBe(4 * block);
    expect(locateRange(pieces, block + 1, GIB)?.end).toBe(5 * block);
  });

  it('has nothing to say past the end of the file', () => {
    expect(locateRange(pieces, 2 * GIB + 10, 2 * GIB + 20)).toBeNull();
  });
});

describe('keeping recent blocks of video', () => {
  const BLOCK = 512 * 1024;
  const SIZE = 40 * BLOCK;
  const data = new Uint8Array(SIZE).map((_, i) => (i * 31) % 251);
  const ctx = { session: 's', library: { channelId: 'one', accessHash: '0' } };

  function counted() {
    const asked: [number, number][] = [];
    const storage = {
      getPhotoRange: async (_ctx: unknown, _id: number, start: number, end: number) => {
        asked.push([start, end]);
        return data.slice(start, end);
      },
    } as never;
    return { cache: new BlockCache(storage), asked };
  }
  const spot = (start: number, end: number) => ({ messageId: 1, pieceSize: SIZE, start, end });

  it('returns exactly what was asked for, from whole blocks', async () => {
    const { cache, asked } = counted();
    const bytes = await cache.read(ctx, spot(BLOCK - 10, BLOCK + 10));
    expect(sha256(bytes)).toBe(sha256(data.subarray(BLOCK - 10, BLOCK + 10)));
    expect(asked).toEqual([[0, BLOCK], [BLOCK, 2 * BLOCK]]);
  });

  it('asks Telegram only once for a stretch a player reads repeatedly', async () => {
    const { cache, asked } = counted();
    await cache.read(ctx, spot(100, 200));
    await cache.read(ctx, spot(300, 400));
    await cache.read(ctx, spot(0, BLOCK));
    expect(asked).toHaveLength(1);
  });

  it('shares a request already on its way', async () => {
    const { cache, asked } = counted();
    await Promise.all([cache.read(ctx, spot(0, 10)), cache.read(ctx, spot(20, 30))]);
    expect(asked).toHaveLength(1);
  });

  it('does not run past the end of a piece', async () => {
    const { cache, asked } = counted();
    const short = { messageId: 1, pieceSize: BLOCK + 100, start: BLOCK, end: BLOCK + 100 };
    expect((await cache.read(ctx, short)).length).toBe(100);
    expect(asked).toEqual([[BLOCK, BLOCK + 100]]);
  });

  it('holds only so much, dropping what was used longest ago', async () => {
    const { cache, asked } = counted();
    await cache.read(ctx, spot(0, 10));
    for (let block = 1; block <= 32; block++) await cache.read(ctx, spot(block * BLOCK, block * BLOCK + 10));
    asked.length = 0;
    await cache.read(ctx, spot(32 * BLOCK, 32 * BLOCK + 10));
    expect(asked).toHaveLength(0);
    await cache.read(ctx, spot(0, 10));
    expect(asked).toHaveLength(1);
  });

  it('tries again after a failure instead of remembering it', async () => {
    let failing = true;
    const storage = {
      getPhotoRange: async (_ctx: unknown, _id: number, start: number, end: number) => {
        if (failing) throw new Error('Connection lost');
        return data.slice(start, end);
      },
    } as never;
    const cache = new BlockCache(storage);
    await expect(cache.read(ctx, spot(0, 10))).rejects.toThrow('Connection lost');
    failing = false;
    expect((await cache.read(ctx, spot(0, 10))).length).toBe(10);
  });

  it('cannot mix up two accounts, whose message ids overlap', async () => {
    const { cache, asked } = counted();
    await cache.read(ctx, spot(0, 10));
    await cache.read({ ...ctx, library: { channelId: 'two', accessHash: '0' } }, spot(0, 10));
    expect(asked).toHaveLength(2);
  });
});

describe('the caption of a piece', () => {
  const hash = 'a'.repeat(64);
  const facts = { filename: 'clip.mp4', sha256: hash, takenAt: '2024-07-01T18:22:10', width: 1920, height: 1080 };
  const part = { index: 2, count: 4, totalSize: 5 * GIB, mime: 'video/mp4' };

  it('reads back everything needed to rebuild the video', () => {
    expect(parseCaption(buildCaption({ ...facts, part }))).toEqual({ sha256: hash, takenAt: facts.takenAt, width: 1920, height: 1080, part });
  });

  it('still works with no size known, and leaves ordinary captions unchanged', () => {
    expect(parseCaption(buildCaption({ ...facts, width: null, height: null, part }))?.part).toEqual(part);
    expect(buildCaption(facts)).not.toContain('part');
    expect(parseCaption(buildCaption(facts))).toEqual({ sha256: hash, takenAt: facts.takenAt, width: 1920, height: 1080 });
  });

  it('says which piece it is, for someone browsing the channel', () => {
    expect(buildCaption({ ...facts, part })).toContain('clip.mp4 (part 2 of 4)');
  });

  it('fits Telegram\'s caption limit even with a very long name', () => {
    expect(buildCaption({ ...facts, filename: 'x'.repeat(5000), part }).length).toBeLessThanOrEqual(1024);
    expect(parseCaption(buildCaption({ ...facts, filename: 'x'.repeat(5000), part }))?.part).toEqual(part);
  });

  it('ignores nonsense part numbers', () => {
    const machine = (p: string) => `telephoto:v1 sha256=${hash} taken=2024-07-01T18:22:10 part=${p} total=10 mime=video/mp4`;
    expect(parseCaption(machine('0/2'))).toBeNull();
    expect(parseCaption(machine('3/2'))).toBeNull();
    expect(parseCaption(machine('1/2'))).not.toBeNull();
  });
});

describe('videos in the library', () => {
  let d: Device;
  const e = () => d.engine;

  beforeEach(async () => {
    d = await new Device().open({ split: SPLIT });
    await d.signIn();
  });
  afterEach(async () => {
    await d.close();
  });

  describe('what gets accepted', () => {
    it.each([
      ['MP4', 'ftypmp42', 'video/mp4'],
      ['MOV', 'ftypqt  ', 'video/quicktime'],
      ['M4V', 'ftypM4V ', 'video/x-m4v'],
    ])('recognises %s from its contents', async (_label, brand, mime) => {
      const bytes = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(brand), Buffer.alloc(200)]);
      expect(e().photo(await d.addOk(bytes, 'nameless')).mime).toBe(mime);
    });

    it('recognises AVI from its contents', async () => {
      const bytes = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('AVI LIST'), Buffer.alloc(200)]);
      expect(e().photo(await d.addOk(bytes, 'nameless')).mime).toBe('video/vnd.avi');
    });

    it('still refuses audio, which shares its container with video', async () => {
      const bytes = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A '), Buffer.alloc(200)]);
      await expect(d.add(bytes, 'song.mp4')).rejects.toMatchObject({ status: 415, code: 'NOT_A_PHOTO' });
    });

    it('refuses a photo too large for one message, as only a video can be split', async () => {
      await expect(d.add(makeJpeg({ color: 'x'.repeat(200) }), 'a.jpg')).resolves.toBeDefined();
      const big = Buffer.concat([Buffer.from(makeJpeg()), Buffer.alloc(SPLIT.maxSingleBytes)]);
      await expect(d.add(big, 'b.jpg')).rejects.toMatchObject({ status: 413, code: 'TOO_LARGE' });
    });

    it('stores a video that fits in one message exactly as it stores a photo', async () => {
      const puts: PutPhotoInput[] = [];
      d.storage.onPut = (input) => puts.push(input);
      const bytes = makeMp4();
      const id = await d.stored(bytes, 'clip.mp4');
      expect(puts).toHaveLength(1);
      expect(puts[0]).toMatchObject({ filename: 'clip.mp4', mime: 'video/mp4', size: bytes.length });
      expect(parseCaption(puts[0]!.caption)?.part).toBeUndefined();
      expect(e().photo(id)).toMatchObject({ status: 'stored', pieceCount: 1, width: 1920, height: 1080 });
      expect(e().store.getPhoto(id)!.tg_parts).toBeNull();
      expect(sha256(await blobBytes(await e().original(id)))).toBe(sha256(bytes));
    });

    it('is told apart from a photo in the grid', async () => {
      await d.stored(makeMp4(), 'clip.mp4');
      await d.stored(makeJpeg(), 'a.jpg');
      expect(Object.fromEntries(e().photos({}).map((p) => [p.filename, p.isVideo]))).toEqual({ 'clip.mp4': true, 'a.jpg': false });
    });
  });

  describe('when it was recorded', () => {
    const recordedAt = new Date(Date.UTC(2023, 2, 4, 5, 6, 7));
    const wallClock = new Date(recordedAt.getTime() - recordedAt.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);

    it.each([
      ['with the header first', {}],
      ['with the header after the video data, as many cameras write it', { moovAtEnd: true }],
      ['with a 64-bit date', { wideMvhd: true }],
    ])('comes from the file, %s', async (_label, options) => {
      const id = await d.addOk(makeMp4({ recordedAt, ...options }), 'clip.mp4', '2020-01-01T00:00:00');
      expect(e().photo(id)).toMatchObject({ takenAt: wallClock, takenSource: 'exif' });
    });

    it('falls back to the file date for a device with no clock set', async () => {
      const id = await d.addOk(makeMp4({ recordedAt: new Date(Date.UTC(1904, 0, 1)) }), 'clip.mp4', '2020-01-01T00:00:00');
      expect(e().photo(id)).toMatchObject({ takenAt: '2020-01-01T00:00:00', takenSource: 'file' });
    });

    it('falls back to the file date for a format that keeps it elsewhere', async () => {
      const avi = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('AVI LIST'), Buffer.alloc(200)]);
      const id = await d.addOk(avi, 'clip.avi', '2020-01-01T00:00:00');
      expect(e().photo(id)).toMatchObject({ takenAt: '2020-01-01T00:00:00', takenSource: 'file' });
    });
  });

  describe('a video too large for one message', () => {
    const original = makeMp4({ size: 8000, seed: 7 });

    it('goes up as numbered pieces, each one a plain file carrying what it takes to rebuild the whole', async () => {
      const puts: PutPhotoInput[] = [];
      d.storage.onPut = (input) => puts.push(input);
      const id = await d.stored(original, 'clip.mp4');

      expect(puts.map((p) => p.filename)).toEqual(['clip.mp4.001', 'clip.mp4.002', 'clip.mp4.003']);
      for (const put of puts) {
        expect(put.mime).toBe('application/octet-stream');
        expect(put.file.size).toBe(put.size);
        expect(put.size).toBeLessThanOrEqual(SPLIT.pieceBytes);
        expect(parseCaption(put.caption)).toMatchObject({ sha256: sha256(original), part: { count: 3, totalSize: original.length, mime: 'video/mp4' } });
      }
      expect(puts.map((p) => parseCaption(p.caption)?.part?.index)).toEqual([1, 2, 3]);
      // The first stands for the whole video, so it has the only thumbnail.
      expect(puts.map((p) => p.thumb !== null)).toEqual([true, false, false]);

      expect(e().photo(id)).toMatchObject({ status: 'stored', filename: 'clip.mp4', mime: 'video/mp4', size: original.length, pieceCount: 3 });
    });

    it('shows steady progress across all the pieces, not each one over again', async () => {
      const seen: number[] = [];
      const progress = e().queue.progress;
      const set = progress.set.bind(progress);
      progress.set = (id, fraction) => {
        seen.push(fraction);
        return set(id, fraction);
      };
      await d.stored(original, 'clip.mp4');
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
      expect(seen.at(-1)).toBeCloseTo(1);
    });

    it('comes back as one file, byte for byte, however it is asked for', async () => {
      const id = await d.stored(original, 'clip.mp4');
      expect(sha256(await blobBytes(await e().original(id)))).toBe(sha256(original));
      expect(sha256(await joined(await e().openOriginalStream(id)))).toBe(sha256(original));
    });

    it('reads any stretch of it, including across the join between two pieces', async () => {
      const id = await d.stored(original, 'clip.mp4');
      for (const [start, end] of [[0, 100], [SPLIT.pieceBytes - 50, SPLIT.pieceBytes + 50], [2900, 6100], [original.length - 1, original.length], [0, original.length]] as const) {
        const bytes = await readAll(d, id, start, end);
        expect(sha256(bytes)).toBe(sha256(original.subarray(start, end)));
      }
    });

    it('reads only the piece a seek lands in, leaving the rest of the video where it is', async () => {
      const id = await d.stored(original, 'clip.mp4');
      d.storage.fetchCount = 0;
      d.storage.rangeFetchCount = 0;
      await e().readRange(id, SPLIT.pieceBytes + 10, SPLIT.pieceBytes + 20);
      expect(d.storage.rangeFetchCount).toBe(1);
      expect(d.storage.fetchCount).toBe(0);
    });

    it('plays from this device for as long as it is still being uploaded', async () => {
      d.storage.failNextPut = new Error('offline');
      const id = await d.addOk(original, 'clip.mp4');
      d.storage.rangeFetchCount = 0;
      expect(sha256(await readAll(d, id, 0, original.length))).toBe(sha256(original));
      expect(d.storage.rangeFetchCount).toBe(0);
      await e().queue.drain();
    });

    it('never downloads a video just to make a preview, even one small enough to', async () => {
      const id = await d.stored(makeMp4(), 'clip.mp4');
      await d.wipeBrowser();
      await d.signIn();
      d.storage.fetchCount = 0;
      d.storage.rangeFetchCount = 0;
      await e().preview(e().photos({})[0]!.id, { force: true });
      expect(d.storage.fetchCount + d.storage.rangeFetchCount).toBe(0);
      expect(id).toBeGreaterThan(0);
    });

    describe('when something goes wrong during the upload', () => {
      /** Fails the first attempt at one piece, as a dropped connection would. */
      const failingOn = (suffix: string) => {
        const names: string[] = [];
        let failed = false;
        d.storage.onPut = (input) => {
          names.push(input.filename);
          if (!failed && input.filename.endsWith(suffix)) {
            failed = true;
            d.storage.failNextPut = new Error('Connection lost');
          }
        };
        return names;
      };

      it('picks up from the piece that failed, without sending the earlier ones again', async () => {
        const names = failingOn('.002');
        const id = await d.addOk(original, 'clip.mp4');
        await e().queue.drain();
        expect(names).toEqual(['clip.mp4.001', 'clip.mp4.002']);
        expect(e().photo(id)).toMatchObject({ status: 'queued', error: 'Connection lost' });
        expect(await d.storage.storedCount(SESSION)).toBe(1);

        await e().store.rescheduleUpload(id, 0, null, false);
        await e().queue.drain();
        expect(names).toEqual(['clip.mp4.001', 'clip.mp4.002', 'clip.mp4.002', 'clip.mp4.003']);
        expect(e().photo(id).status).toBe('stored');
        expect(await d.storage.storedCount(SESSION)).toBe(3);
        expect(sha256(await blobBytes(await e().original(id)))).toBe(sha256(original));
      });

      it('carries on where it stopped after the tab was closed and the same file is added again', async () => {
        const names = failingOn('.002');
        const id = await d.addOk(original, 'clip.mp4');
        await e().queue.drain();
        await d.reload();
        expect(e().photo(id).status).toBe('failed');
        expect(e().uploadStatus().items[0]).toMatchObject({ id, needsFile: true });

        names.length = 0;
        expect(await d.add(original, 'clip.mp4')).toMatchObject({ id, duplicate: false });
        await e().queue.drain();
        expect(names).toEqual(['clip.mp4.002', 'clip.mp4.003']);
        expect(e().photo(id)).toMatchObject({ status: 'stored', pieceCount: 3 });
        expect(sha256(await blobBytes(await e().original(id)))).toBe(sha256(original));
      });

      it('only counts failures since the last piece that got through, as a long upload will hit several', async () => {
        failingOn('.002');
        const id = await d.addOk(original, 'clip.mp4');
        await e().store.rescheduleUpload(id, 0, 'earlier', true);
        await e().queue.drain();
        // One for the failure just now. The earlier one was wiped out by the first piece succeeding.
        expect(e().store.getPhoto(id)!.attempts).toBe(1);
      });

      it('does not offer a half-sent video as if it could be played', async () => {
        failingOn('.002');
        const id = await d.addOk(original, 'clip.mp4');
        await e().queue.drain();
        await d.reload();
        await expect(e().readRange(id, 0, 10)).rejects.toMatchObject({ code: 'FILE_NEEDED' });
        await expect((async () => e().original(id))()).rejects.toMatchObject({ code: 'FILE_NEEDED' });
      });

      it('removes what was already sent if the upload is given up on', async () => {
        failingOn('.002');
        const id = await d.addOk(original, 'clip.mp4');
        await e().queue.drain();
        await d.reload();
        expect(await d.storage.storedCount(SESSION)).toBe(1);
        await e().cancelUpload(id);
        expect(await d.storage.storedCount(SESSION)).toBe(0);
        expect(e().store.allPhotos()).toEqual([]);
      });

      it('stops between pieces when the tab hands the library over', async () => {
        const names: string[] = [];
        d.storage.onPut = (input) => {
          names.push(input.filename);
          e().queue.stop();
        };
        const id = await d.addOk(original, 'clip.mp4');
        await e().queue.drain();
        expect(names).toEqual(['clip.mp4.001']);
        expect(e().store.getPhoto(id)!.tg_parts).toHaveLength(1);
      });
    });

    it('goes into a zip whole, alongside anything else selected', async () => {
      const video = await d.stored(original, 'clip.mp4');
      const photoBytes = makeJpeg();
      const photo = await d.stored(photoBytes, 'a.jpg');
      const dir = mkdtempSync(join(tmpdir(), 'tp-zip-video-'));
      try {
        const zip = join(dir, 'a.zip');
        writeFileSync(zip, Buffer.from(await zipOf(e(), e().photosForDownload([video, photo])).arrayBuffer()));
        execFileSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, dir]);
        expect(sha256(readFileSync(join(dir, 'clip.mp4')))).toBe(sha256(original));
        expect(sha256(readFileSync(join(dir, 'a.jpg')))).toBe(sha256(photoBytes));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    describe('when it is deleted', () => {
      it('takes every piece with it', async () => {
        const id = await d.stored(original, 'clip.mp4');
        expect(await d.storage.storedCount(SESSION)).toBe(3);
        await e().setTrashed([id], true);
        await e().deleteForever([id]);
        expect(await d.storage.storedCount(SESSION)).toBe(0);
      });

      it('is not brought back by a rescan', async () => {
        const id = await d.stored(original, 'clip.mp4');
        await e().setTrashed([id], true);
        await e().deleteForever([id]);
        e().rescan();
        await e().whenIdle();
        expect(e().photos({})).toEqual([]);
      });
    });

    describe('if the pieces in Telegram are not what was sent', () => {
      it('refuses to hand over a video put back together wrongly', async () => {
        const id = await d.stored(original, 'clip.mp4');
        const row = e().store.getPhoto(id)!;
        const [one, two, three] = row.tg_parts!;
        row.tg_parts = [two!, one!, three!];
        await expect(joined(await e().openOriginalStream(id))).rejects.toMatchObject({ code: 'PIECES_DAMAGED' });
        await expect(e().original(id)).rejects.toMatchObject({ code: 'PIECES_DAMAGED' });
      });

      it('says so plainly when a piece has been deleted by hand', async () => {
        const id = await d.stored(original, 'clip.mp4');
        const row = e().store.getPhoto(id)!;
        await d.storage.deletePhotos(CTX, [row.tg_parts![1]!.messageId]);
        await expect(joined(await e().openOriginalStream(id))).rejects.toBeInstanceOf(OriginalMissingError);
        await expect(e().readRange(id, SPLIT.pieceBytes + 1, SPLIT.pieceBytes + 2)).rejects.toBeInstanceOf(OriginalMissingError);
      });
    });

    describe('on another device', () => {
      it('is rebuilt from the channel as one video, with everything it had', async () => {
        await d.stored(original, 'clip.mp4');
        await d.wipeBrowser();
        await d.signIn();
        const [video, ...rest] = e().photos({});
        expect(rest).toEqual([]);
        expect(video).toMatchObject({ filename: 'clip.mp4', isVideo: true, width: 1920, height: 1080 });
        expect(e().photo(video!.id)).toMatchObject({ mime: 'video/mp4', size: original.length, pieceCount: 3, status: 'stored', previewState: 'ready' });
        expect(sha256(await blobBytes(await e().original(video!.id)))).toBe(sha256(original));
        expect(sha256(await readAll(d, video!.id, 2900, 3100))).toBe(sha256(original.subarray(2900, 3100)));
      });

      it('gets its thumbnail from the first piece, without downloading any of the video', async () => {
        await d.stored(original, 'clip.mp4');
        await d.wipeBrowser();
        await d.signIn();
        d.storage.fetchCount = 0;
        expect(await e().thumb(e().photos({})[0]!.id)).not.toBeNull();
        expect(d.storage.fetchCount).toBe(0);
      });

      const hash = sha256(original);
      const inject = (index: number) => {
        const plan = planPieces(original.length, SPLIT);
        const { start, end } = plan[index - 1]!;
        const file = new Blob([original.subarray(start, end) as BlobPart]);
        const caption = buildCaption({
          filename: 'clip.mp4', sha256: hash, takenAt: '2024-07-01T18:22:10', width: 640, height: 360,
          part: { index, count: plan.length, totalSize: original.length, mime: 'video/mp4' },
        });
        return d.storage.inject(SESSION, { filename: `clip.mp4.00${index}`, size: file.size, mime: 'application/octet-stream', caption, hasThumb: index === 1, file, thumb: null });
      };

      it('stays hidden until every piece is there, however many scans that takes', async () => {
        await inject(1);
        await d.catchUp();
        expect(e().photos({})).toEqual([]);
        await inject(2);
        await d.catchUp();
        expect(e().photos({})).toEqual([]);
        await inject(3);
        await d.catchUp();
        const [video] = e().photos({});
        expect(e().photo(video!.id)).toMatchObject({ filename: 'clip.mp4', size: original.length, pieceCount: 3 });
        expect(sha256(await blobBytes(await e().original(video!.id)))).toBe(hash);
      });

      it('remembers the pieces it has seen across a reload', async () => {
        await inject(1);
        await d.catchUp();
        await d.reload();
        await inject(2);
        await inject(3);
        await d.catchUp();
        expect(e().photos({})).toHaveLength(1);
      });

      it('puts them in order whatever order they arrived in', async () => {
        await inject(3);
        await inject(1);
        await d.catchUp();
        await inject(2);
        await d.catchUp();
        const [video] = e().photos({});
        expect(sha256(await blobBytes(await e().original(video!.id)))).toBe(hash);
        expect(e().photo(video!.id).previewState).toBe('ready');
      });

      it('is not fooled by a piece sent twice', async () => {
        await inject(1);
        await inject(1);
        await inject(2);
        await d.catchUp();
        expect(e().photos({})).toEqual([]);
        await inject(3);
        await d.catchUp();
        expect(e().photos({})).toHaveLength(1);
        expect(sha256(await blobBytes(await e().original(e().photos({})[0]!.id)))).toBe(hash);
      });

      it('does not bring back pieces of a video deleted on another device', async () => {
        await inject(1);
        await d.catchUp();
        e().sync.recordDeleted([hash]);
        await inject(2);
        await inject(3);
        await d.catchUp();
        expect(e().photos({})).toEqual([]);
      });

      it('can finish an upload begun elsewhere only by adding the file, leaving it alone otherwise', async () => {
        await inject(1);
        await d.catchUp();
        expect(e().uploadStatus().items).toEqual([]);
        await d.stored(original, 'clip.mp4');
        expect(e().photos({})).toHaveLength(1);
      });
    });
  });

  describe('a real file over the 2 GB limit, with the real limits', () => {
    const TOTAL = Math.floor(2.5 * GIB);
    let dir: string;
    let big: Device;
    let header: Uint8Array;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'tp-big-video-'));
      big = await new Device().open();
      await big.signIn();
      header = makeMp4({ size: 1000 });
    });
    afterEach(async () => {
      await big.close();
      rmSync(dir, { recursive: true, force: true });
    });

    /** Sparse, so it takes no real disk space, but is read back at its full size. */
    async function sparseVideo(): Promise<Blob> {
      const path = join(dir, 'big.mp4');
      const fd = openSync(path, 'w');
      writeSync(fd, header);
      closeSync(fd);
      execFileSync('truncate', ['-s', String(TOTAL), path]);
      return openAsBlob(path);
    }

    it('splits it, stores it, and returns exactly what went in', { timeout: 300_000 }, async () => {
      const file = await sparseVideo();
      const puts: PutPhotoInput[] = [];
      big.storage.onPut = (input) => puts.push(input);
      const { id } = await big.engine.ingest(file, 'big.mp4', null);
      await big.engine.queue.drain();

      expect(puts.map((p) => p.size)).toEqual([GIB, GIB, TOTAL - 2 * GIB]);
      for (const put of puts) expect(put.size).toBeLessThanOrEqual(TELEGRAM_SPLIT.maxSingleBytes);
      expect(big.engine.photo(id)).toMatchObject({ status: 'stored', size: TOTAL, pieceCount: 3 });

      // Across the first join, which sits past where a 32-bit offset would give out for the second.
      const read = async (start: number, end: number) => {
        const chunks: Uint8Array[] = [];
        for (let at = start; at < end; ) {
          const bytes = await big.engine.readRange(id, at, end);
          chunks.push(bytes);
          at += bytes.length;
        }
        return new Uint8Array(Buffer.concat(chunks));
      };
      const across = await read(GIB - 4, GIB + 4);
      expect([...across]).toEqual(new Array(8).fill(0));
      expect((await read(2 * GIB, 2 * GIB + 16)).length).toBe(16);

      // The full hash is checked on the way through, so this throws if it does not match.
      let length = 0;
      for await (const chunk of await big.engine.openOriginalStream(id)) length += chunk.length;
      expect(length).toBe(TOTAL);
      expect(big.engine.store.getPhoto(id)!.sha256).toBe(await hashBlob(file));
    });
  });

  describe('through the media worker', () => {
    const original = makeMp4({ size: 8000, seed: 9 });
    let frames: { src: string; hidden: boolean; remove: () => void }[];
    let pageReceived: WorkerRequest[];

    /** The worker's real code, wired directly to the page's real answers, standing in only for the browser between them. */
    function loadWorker() {
      const listeners: Record<string, (event: never) => void> = {};
      const client = {
        postMessage(message: WorkerRequest, ports: MessagePort[] = []) {
          pageReceived.push(message);
          void answerWorker(message).then((reply) => ports[0]?.postMessage(reply, reply.bytes ? [reply.bytes] : []));
        },
      };
      const self = {
        location: { origin: 'https://app.test' },
        skipWaiting: () => undefined,
        clients: { claim: async () => undefined, get: async () => client, matchAll: async () => [client] },
        addEventListener: (name: string, listener: (event: never) => void) => {
          listeners[name] = listener;
        },
      };
      new Function('self', readFileSync(join(import.meta.dirname, '../public/media-sw.js'), 'utf8'))(self);
      return {
        fetch(path: string, headers: Record<string, string> = {}, clientId = 'page') {
          return new Promise<Response | null>((resolve) => {
            let answered = false;
            listeners.fetch!({
              request: new Request(`https://app.test${path}`, { headers }),
              clientId,
              respondWith: (response: Promise<Response>) => {
                answered = true;
                void response.then(resolve);
              },
            } as never);
            if (!answered) resolve(null);
          });
        },
      };
    }

    beforeEach(() => {
      frames = [];
      pageReceived = [];
      const listeners = new Set<() => void>();
      vi.stubGlobal('navigator', {
        serviceWorker: {
          controller: { postMessage: () => undefined },
          ready: Promise.resolve(),
          register: async () => undefined,
          startMessages: () => undefined,
          addEventListener: (_name: string, listener: () => void) => listeners.add(listener),
        },
      });
      vi.stubGlobal('document', {
        body: { append: () => undefined },
        createElement: () => {
          const frame = { src: '', hidden: false, remove: () => undefined };
          frames.push(frame);
          return frame;
        },
      });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const bytesOf = async (response: Response | null) => new Uint8Array(await response!.arrayBuffer());

    it('leaves every other request alone', async () => {
      expect(await loadWorker().fetch('/assets/app.js')).toBeNull();
      expect(await loadWorker().fetch('/')).toBeNull();
    });

    it('turns away a token it did not issue, so a link from elsewhere reaches nothing', async () => {
      const response = await loadWorker().fetch('/__media/made-up');
      expect(response!.status).toBe(404);
    });

    it('stops answering once the viewer has closed the video', async () => {
      const id = await d.stored(original, 'clip.mp4');
      const opened = (await openVideo(e(), id))!;
      opened.close();
      expect((await loadWorker().fetch(opened.url))!.status).toBe(404);
    });

    it('serves the start of a video the way a browser first asks for it', async () => {
      const id = await d.stored(original, 'clip.mp4');
      const { url, close } = (await openVideo(e(), id))!;
      const response = await loadWorker().fetch(url, { Range: 'bytes=0-' });
      expect(response!.status).toBe(206);
      expect(response!.headers.get('Content-Type')).toBe('video/mp4');
      expect(response!.headers.get('Accept-Ranges')).toBe('bytes');
      expect(response!.headers.get('Content-Length')).toBe(String(original.length));
      expect(response!.headers.get('Content-Range')).toBe(`bytes 0-${original.length - 1}/${original.length}`);
      expect(sha256(await bytesOf(response))).toBe(sha256(original));
      close();
    });

    it('serves a range across the join between two pieces', async () => {
      const id = await d.stored(original, 'clip.mp4');
      const { url, close } = (await openVideo(e(), id))!;
      const [start, end] = [SPLIT.pieceBytes - 100, SPLIT.pieceBytes + 100];
      const response = await loadWorker().fetch(url, { Range: `bytes=${start}-${end - 1}` });
      expect(response!.status).toBe(206);
      expect(response!.headers.get('Content-Range')).toBe(`bytes ${start}-${end - 1}/${original.length}`);
      expect(sha256(await bytesOf(response))).toBe(sha256(original.subarray(start, end)));
      close();
    });

    it('answers the two-byte probe Safari starts with exactly', async () => {
      const id = await d.stored(original, 'clip.mp4');
      const { url, close } = (await openVideo(e(), id))!;
      const response = await loadWorker().fetch(url, { Range: 'bytes=0-1' });
      expect(response!.headers.get('Content-Length')).toBe('2');
      expect((await bytesOf(response)).length).toBe(2);
      close();
    });

    it('handles the rest of what a range can say', async () => {
      const id = await d.stored(original, 'clip.mp4');
      const { url, close } = (await openVideo(e(), id))!;
      const worker = loadWorker();
      const size = original.length;

      const whole = await worker.fetch(url);
      expect(whole!.status).toBe(200);
      expect(sha256(await bytesOf(whole))).toBe(sha256(original));

      const tail = await worker.fetch(url, { Range: 'bytes=-10' });
      expect(tail!.headers.get('Content-Range')).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
      expect(sha256(await bytesOf(tail))).toBe(sha256(original.subarray(size - 10)));

      const beyond = await worker.fetch(url, { Range: `bytes=0-${size + 500}` });
      expect(beyond!.headers.get('Content-Length')).toBe(String(size));
      await beyond!.arrayBuffer();

      const past = await worker.fetch(url, { Range: `bytes=${size}-` });
      expect(past!.status).toBe(416);
      expect(past!.headers.get('Content-Range')).toBe(`bytes */${size}`);
      close();
    });

    it('only reads as far as the player has asked for, so a pause costs no more downloads', async () => {
      // Large enough that a read that ran ahead would still have plenty left to do.
      const long = makeMp4({ size: 20 * 1024 * 1024, seed: 3 });
      const roomy = await new Device().open({ split: { maxSingleBytes: 5 * 1024 * 1024, pieceBytes: 4 * 1024 * 1024 } });
      await roomy.signIn();
      const id = await roomy.stored(long, 'long.mp4');
      const { url, close } = (await openVideo(roomy.engine, id))!;
      const response = await loadWorker().fetch(url, { Range: 'bytes=0-' });
      const reader = response!.body!.getReader();
      await reader.read();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const reads = pageReceived.filter((m) => m.type === 'read') as Extract<WorkerRequest, { type: 'read' }>[];
      expect(reads.length).toBeLessThanOrEqual(3);
      // Starts small, in case this is only the player looking around the file.
      expect(reads[0]).toMatchObject({ start: 0, end: 1024 * 1024 });
      await reader.cancel();
      close();
      await roomy.close();
    });

    it('fails the stream rather than ending it early if Telegram stops answering', async () => {
      const id = await d.stored(original, 'clip.mp4');
      const { url, close } = (await openVideo(e(), id))!;
      d.storage.failReads = new Error('Connection lost');
      const response = await loadWorker().fetch(url, { Range: 'bytes=0-' });
      await expect(response!.arrayBuffer()).rejects.toThrow();
      d.storage.failReads = null;
      close();
    });

    describe('downloading, for a browser with no save dialog', () => {
      beforeEach(() => {
        vi.stubGlobal('window', {});
      });

      /** Starts a download and waits for the page to ask the browser to fetch it. */
      async function start(ids: number[]) {
        const done = downloadOriginals(e(), ids);
        await vi.waitFor(() => expect(frames.at(-1)?.src).toBeTruthy());
        return { done, url: frames.at(-1)!.src };
      }

      /** Anything this small would normally just be gathered in memory, so these have to be big enough not to be. */
      const bigEnough = (photoId: number) => {
        const row = e().store.getPhoto(photoId)!;
        row.size = 300 * 1024 * 1024;
        return row;
      };

      it('saves the joined video under its real name, as an attachment', async () => {
        const id = await d.stored(original, 'my clip (1).mp4');
        const row = bigEnough(id);
        const { done, url } = await start([id]);
        const response = await loadWorker().fetch(url, {}, '');
        expect(response!.status).toBe(200);
        expect(response!.headers.get('Content-Disposition')).toBe("attachment; filename*=UTF-8''my%20clip%20%281%29.mp4");
        expect(response!.headers.get('Content-Length')).toBe(String(row.size));
        expect(sha256(await bytesOf(response))).toBe(sha256(original));
        await expect(done).resolves.toBeUndefined();
      });

      it('fails the download at the very end if the pieces did not add up, so no damaged file looks finished', async () => {
        const id = await d.stored(original, 'clip.mp4');
        const row = bigEnough(id);
        const [one, two, three] = row.tg_parts!;
        row.tg_parts = [two!, one!, three!];
        const { done, url } = await start([id]);
        const response = await loadWorker().fetch(url, {}, '');
        const failure = done.catch((err: unknown) => err);
        await expect(response!.arrayBuffer()).rejects.toThrow();
        expect(await failure).toMatchObject({ code: 'PIECES_DAMAGED' });
      });

      it('ends cleanly when the person cancels it in the browser', async () => {
        const id = await d.stored(original, 'clip.mp4');
        bigEnough(id);
        const { done, url } = await start([id]);
        const response = await loadWorker().fetch(url, {}, '');
        await response!.body!.cancel();
        await expect(done).resolves.toBeUndefined();
      });
    });
  });
});
