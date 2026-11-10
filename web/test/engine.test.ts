import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCaption, parseCaption } from '../src/engine/caption';
import { zipOf } from '../src/engine/download';
import { FAKE_CODE, FAKE_PASSWORD, FakeStorage } from '../src/engine/fake';
import { MAX_PHOTO_BYTES } from '../src/engine/index';
import { fitInside, hashBlob } from '../src/engine/media';
import { INTERRUPTED_MESSAGE } from '../src/engine/queue';
import { OriginalMissingError, RateLimitedError, SessionRevokedError } from '../src/engine/types';
import { blobBytes, Device, makeJpeg, sha256 } from './helpers';

const SESSION = 'fake:+15550000001';

describe('the engine', () => {
  let d: Device;
  beforeEach(async () => {
    d = await new Device().open();
  });
  afterEach(async () => {
    await d.close();
  });

  const e = () => d.engine;

  describe('sign-in and access', () => {
    it('refuses everything private until signed in', async () => {
      const calls: (() => unknown)[] = [
        () => e().photos({}), () => e().photo(1), () => e().thumb(1), () => e().preview(1), () => e().original(1),
        () => e().setFavorite([1], true), () => e().setTrashed([1], true), () => e().deleteForever([1]), () => e().emptyTrash(),
        () => e().libraryInfo(), () => e().rescan(), () => e().albums(), () => e().album(1), () => e().createAlbum('x'),
        () => e().updateAlbum(1, {}), () => e().deleteAlbum(1), () => e().addToAlbum(1, [1]), () => e().removeFromAlbum(1, [1]),
        () => e().ingest(new Blob(['x']), 'a.jpg', null), () => e().uploadStatus(), () => e().retryUploads(), () => e().cancelUpload(1),
      ];
      for (const call of calls) {
        await expect((async () => call())()).rejects.toMatchObject({ status: 401 });
      }
    });

    it('rejects a wrong code, then accepts the right one', async () => {
      const { loginId } = await e().sendCode('+15550000001');
      await expect(e().submitCode(loginId, '000')).rejects.toMatchObject({ code: 'CODE_INVALID', status: 400 });
      expect(await e().submitCode(loginId, FAKE_CODE)).toEqual({ status: 'ok' });
      expect(e().session().account?.firstName).toBe('Demo');
    });

    it('goes through two-step verification when the account uses it', async () => {
      const { loginId } = await e().sendCode('+15550000002');
      expect(await e().submitCode(loginId, FAKE_CODE)).toEqual({ status: 'password', hint: 'demo hint' });
      await expect(e().submitPassword(loginId, 'nope')).rejects.toMatchObject({ status: 400 });
      expect(await e().submitPassword(loginId, FAKE_PASSWORD)).toEqual({ status: 'ok' });
    });

    it('rejects malformed phone numbers, and tidies up the formatting of good ones', async () => {
      expect(() => e().sendCode('not a number')).toThrow(/country code/);
      await expect(e().sendCode('+1 (555) 111-2222')).resolves.toMatchObject({ delivery: 'app' });
    });

    it('stays signed in across a reload', async () => {
      await d.signIn();
      await d.reload();
      expect(e().session().account?.firstName).toBe('Demo');
    });

    it('signing out ends the Telegram session and clears this browser', async () => {
      await d.signIn();
      const revoked: string[] = [];
      d.storage.revokeSession = (async (session: string) => void revoked.push(session)) as typeof d.storage.revokeSession;
      await d.stored(makeJpeg());
      await e().signOut();
      expect(revoked).toEqual([SESSION]);
      expect(e().session().account).toBeNull();
      expect(e().store.allPhotos()).toEqual([]);
      expect(await d.storage.storedCount(SESSION)).toBe(1);
    });

    it('shows a new person nothing of the last one, even if the last one never signed out', async () => {
      await d.signIn('+15550000001');
      await d.stored(makeJpeg(), 'alice.jpg');
      await e().setFavorite([1], true);
      await d.signIn('+15550000003');
      expect(d.names()).toEqual([]);
      expect(e().albums()).toEqual([]);
      expect(await d.storage.storedCount('fake:+15550000003')).toBe(0);
      expect(await d.storage.storedCount(SESSION)).toBe(1);
    });

    it('never picks up someone else\'s saved state', async () => {
      await d.signIn('+15550000001');
      await e().createAlbum('Private to Alice');
      await d.saveState();
      await d.signIn('+15550000003');
      await d.catchUp();
      expect(e().albums()).toEqual([]);
    });
  });

  describe('keeping photos intact', () => {
    beforeEach(() => d.signIn());

    it('stores exactly the bytes it was given and hands back exactly those bytes', async () => {
      const original = makeJpeg({ width: 800, height: 600, date: '2021:03:14 09:26:53', camera: 'EOS R5' });
      const id = await d.stored(original, 'IMG_0001.jpg');
      const detail = e().photo(id);
      expect(detail.status).toBe('stored');
      expect(detail.sha256).toBe(sha256(original));
      expect(detail.size).toBe(original.length);
      await d.reload();
      expect(sha256(await blobBytes(await e().original(id)))).toBe(sha256(original));
    });

    it('lets go of the file once Telegram has it', async () => {
      const id = await d.stored(makeJpeg());
      expect(e().queue.hasFile(id)).toBe(false);
      expect(e().hasUploadsInProgress).toBe(false);
    });

    it('sends each photo to storage as a single file, with its thumbnail', async () => {
      const seen: { name: string; thumb: boolean }[] = [];
      d.storage.onPut = (input) => seen.push({ name: input.filename, thumb: input.thumb !== null });
      await d.addOk(makeJpeg({ color: '#111111' }), 'one.jpg');
      await d.addOk(makeJpeg({ color: '#222222' }), 'two.jpg');
      await e().queue.drain();
      expect(seen.map((s) => s.name).sort()).toEqual(['one.jpg', 'two.jpg']);
      expect(seen.every((s) => s.thumb)).toBe(true);
    });

    it('serves a photo that has not reached Telegram yet from the file on this device', async () => {
      d.storage.putDelayMs = 200;
      const original = makeJpeg({ color: '#445566' });
      const id = await d.addOk(original);
      expect(e().hasUploadsInProgress).toBe(true);
      expect(sha256(await blobBytes(await e().original(id)))).toBe(sha256(original));
      await e().queue.drain();
    });

    it('does not pass off a preview as the original', async () => {
      const original = makeJpeg({ width: 3000, height: 2000 });
      const id = await d.stored(original);
      const preview = await blobBytes((await e().preview(id))!);
      expect(sha256(preview)).not.toBe(sha256(original));
    });

    it('hashes in pieces, so a huge file never has to fit in memory', async () => {
      const bytes = crypto.getRandomValues(new Uint8Array(1 << 16));
      const whole = Buffer.concat(Array.from({ length: 300 }, () => bytes));
      let largest = 0;
      const source = new Blob([whole]);
      const spy = {
        size: source.size,
        slice(a: number, b: number) {
          largest = Math.max(largest, b - a);
          return source.slice(a, b);
        },
      } as unknown as Blob;
      expect(await hashBlob(spy)).toBe(sha256(whole));
      expect(largest).toBeLessThanOrEqual(8 * 1024 * 1024);
    });
  });

  describe('what gets accepted', () => {
    beforeEach(() => d.signIn());

    it('rejects non-images, whatever they are named', async () => {
      await expect(d.add(new TextEncoder().encode('this is not an image at all, sorry'.repeat(10)), 'fake.jpg')).rejects.toMatchObject({ status: 415, code: 'NOT_A_PHOTO' });
      expect(d.names()).toEqual([]);
    });

    it('goes by what a file is, so a video named like a photo is stored as a video', async () => {
      const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(200)]);
      const id = await d.stored(mp4, 'clip.jpg');
      expect(e().photo(id).mime).toBe('video/mp4');
      expect(e().photos({})[0]!.isVideo).toBe(true);
    });

    it('rejects an empty file', async () => {
      await expect(d.add(new Uint8Array(0))).rejects.toMatchObject({ code: 'EMPTY_FILE' });
    });

    it('rejects an oversized file from its size alone, before reading any of it', async () => {
      expect(MAX_PHOTO_BYTES).toBe(2_097_152_000);
      const huge = { size: MAX_PHOTO_BYTES + 1, slice: () => { throw new Error('should not have been read'); } } as unknown as Blob;
      await expect(e().ingest(huge, 'a.jpg', null)).rejects.toMatchObject({ status: 413 });
    });

    it('recognises the common web formats from their contents', async () => {
      const samples: [string, Uint8Array, string][] = [
        ['a.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0, 0, 0, 0]), 'image/png'],
        ['a.webp', new Uint8Array(Buffer.concat([Buffer.from('RIFF'), Buffer.from([20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16)])), 'image/webp'],
        ['a.gif', new Uint8Array(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16)])), 'image/gif'],
        ['a.avif', new Uint8Array(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypavif'), Buffer.alloc(16)])), 'image/avif'],
        ['a.tiff', new Uint8Array(Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]), Buffer.alloc(32)])), 'image/tiff'],
      ];
      for (const [name, bytes, mime] of samples) {
        const id = await d.addOk(bytes, name);
        expect(e().photo(id).mime, name).toBe(mime);
      }
      await e().queue.drain();
    });

    it('still stores an image it cannot decode, with a placeholder instead of a thumbnail', async () => {
      // A JPEG header on garbage: looks like a photo, cannot be decoded. Losing it would be worse.
      const broken = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 7)]));
      const id = await d.stored(broken, 'damaged.jpg');
      expect(e().photo(id)).toMatchObject({ status: 'stored', previewState: 'unavailable' });
      expect(await e().thumb(id)).toBeNull();
      expect(sha256(await blobBytes(await e().original(id)))).toBe(sha256(broken));
    });

    it('recognises the same photo added twice and stores it once', async () => {
      const bytes = makeJpeg();
      expect((await d.add(bytes, 'a.jpg')).duplicate).toBe(false);
      await e().queue.drain();
      expect((await d.add(bytes, 'copy-of-a.jpg')).duplicate).toBe(true);
      expect(d.names()).toHaveLength(1);
      expect(await d.storage.storedCount(SESSION)).toBe(1);
    });

    it('stores a photo once when the same bytes arrive at the same moment', async () => {
      const bytes = makeJpeg({ color: '#778899' });
      const results = await Promise.all(Array.from({ length: 5 }, () => d.add(bytes, 'same.jpg')));
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      await e().queue.drain();
      expect(d.names()).toHaveLength(1);
      expect(await d.storage.storedCount(SESSION)).toBe(1);
    });

    it('brings a photo back from Trash when it is added again', async () => {
      const bytes = makeJpeg();
      const id = await d.stored(bytes);
      await e().setTrashed([id], true);
      expect(d.names()).toEqual([]);
      expect((await d.add(bytes)).restored).toBe(true);
      expect(d.names()).toHaveLength(1);
    });

    it('keeps non-English filenames and neutralises hostile ones', async () => {
      const a = await d.addOk(makeJpeg({ color: '#010101' }), 'ছবি 東京 🌸.jpg');
      expect(e().photo(a).filename).toBe('ছবি 東京 🌸.jpg');
      const b = await d.addOk(makeJpeg({ color: '#020202' }), '../../../etc/passwd.jpg');
      expect(e().photo(b).filename).toBe('passwd.jpg');
      await e().queue.drain();
    });
  });

  describe('metadata and the timeline', () => {
    beforeEach(() => d.signIn());

    it('reads the capture date and camera from EXIF', async () => {
      const id = await d.addOk(makeJpeg({ date: '2019:12:31 23:59:58', camera: 'EOS R5' }));
      expect(e().photo(id)).toMatchObject({ takenAt: '2019-12-31T23:59:58', takenSource: 'exif' });
      expect(e().photo(id).camera.model).toBe('EOS R5');
    });

    it('falls back to the file date when there is no EXIF', async () => {
      const id = await d.addOk(makeJpeg(), 'a.jpg', '2015-06-07T08:09:10');
      expect(e().photo(id)).toMatchObject({ takenAt: '2015-06-07T08:09:10', takenSource: 'file' });
    });

    it('ignores a nonsense file date', async () => {
      const id = await d.addOk(makeJpeg(), 'a.jpg', "'; DROP TABLE photos; --");
      expect(e().photo(id).takenSource).toBe('upload');
    });

    it('orders the timeline by when photos were taken, not when added', async () => {
      await d.addOk(makeJpeg({ color: '#a00000', date: '2020:01:01 10:00:00' }), 'middle.jpg');
      await d.addOk(makeJpeg({ color: '#00a000', date: '2023:01:01 10:00:00' }), 'newest.jpg');
      await d.addOk(makeJpeg({ color: '#0000a0', date: '2010:01:01 10:00:00' }), 'oldest.jpg');
      expect(d.names()).toEqual(['newest.jpg', 'middle.jpg', 'oldest.jpg']);
    });

    it('never scales a small photo up, and fits a large one inside its limits', () => {
      expect(fitInside(100, 80, 1024, 512)).toEqual({ width: 100, height: 80 });
      expect(fitInside(4000, 3000, 1024, 512)).toEqual({ width: 683, height: 512 });
      expect(fitInside(10_000, 10, 320, 320)).toEqual({ width: 320, height: 1 });
    });

    it('searches by name, camera, year and month, and treats wildcards as text', async () => {
      await d.addOk(makeJpeg({ color: '#a10000', date: '2019:07:04 10:00:00', camera: 'EOS R5' }), 'beach.jpg');
      await d.addOk(makeJpeg({ color: '#00a100', date: '2021:02:14 10:00:00' }), 'mountain.jpg');
      await d.addOk(makeJpeg({ color: '#0000a1', date: '2021:07:20 10:00:00' }), '100%_real.jpg');
      const names = (q: string) => d.names({ q }).sort();
      expect(names('beach')).toEqual(['beach.jpg']);
      expect(names('eos')).toEqual(['beach.jpg']);
      expect(names('2021')).toEqual(['100%_real.jpg', 'mountain.jpg']);
      expect(names('july')).toEqual(['100%_real.jpg', 'beach.jpg']);
      expect(names('july 2021')).toEqual(['100%_real.jpg']);
      expect(names('%')).toEqual(['100%_real.jpg']);
      expect(names('_')).toEqual(['100%_real.jpg']);
      expect(names('nothing-like-this')).toEqual([]);
    });
  });

  describe('when things go wrong', () => {
    beforeEach(() => d.signIn());

    const clearBackoff = () => {
      for (const p of e().store.allPhotos()) p.next_attempt_at = 0;
    };

    it('holds on to the file and retries when an upload fails', async () => {
      d.storage.failNextPut = new Error('network went away');
      const original = makeJpeg();
      const id = await d.addOk(original);
      await e().queue.drain();
      expect(e().photo(id)).toMatchObject({ status: 'queued', error: 'network went away' });
      expect(e().queue.hasFile(id)).toBe(true);

      clearBackoff();
      await e().queue.drain();
      expect(e().photo(id)).toMatchObject({ status: 'stored', error: null });
      expect(sha256(await blobBytes(await e().original(id)))).toBe(sha256(original));
    });

    it('stops retrying after repeated failures, keeps the file, and can be retried by hand', async () => {
      d.storage.failNextPut = new Error('still broken');
      const id = await d.addOk(makeJpeg());
      await e().queue.drain();
      for (let i = 1; i < 6; i++) {
        d.storage.failNextPut = new Error('still broken');
        clearBackoff();
        await e().queue.drain();
      }
      expect(e().photo(id).status).toBe('failed');
      expect(e().queue.hasFile(id)).toBe(true);
      const status = e().uploadStatus();
      expect(status.items[0]!.status).toBe('failed');
      expect(status.stats.failed).toBe(1);

      expect((await e().retryUploads()).retried).toBe(1);
      await e().queue.drain();
      expect(e().photo(id).status).toBe('stored');
    });

    it('retries a failed batch of 50 without re-uploading photos already stored', async () => {
      const safe = await d.stored(makeJpeg(), 'already-saved.jpg');
      const putPhoto = d.storage.putPhoto.bind(d.storage);
      d.storage.putPhoto = async () => { throw new Error('offline'); };
      const ids: number[] = [];
      for (let i = 0; i < 50; i++) {
        ids.push(await d.addOk(makeJpeg({ color: `batch-${i}` }), `${i}.jpg`));
      }
      for (let i = 0; i < 6; i++) {
        clearBackoff();
        await e().queue.drain();
      }
      expect(e().uploadStatus().stats.failed).toBe(50);
      expect(e().uploadStatus().items.every((item) => !item.needsFile)).toBe(true);

      d.storage.putPhoto = putPhoto;
      expect(await e().retryUploads(ids)).toEqual({ retried: 50 });
      await e().queue.drain();
      expect(ids.every((id) => e().photo(id).status === 'stored')).toBe(true);
      expect(e().photo(safe).status).toBe('stored');
      expect(await d.storage.storedCount(SESSION)).toBe(51);
    });

    it('resumes a failed photo when selected again instead of treating it as a duplicate', async () => {
      const original = makeJpeg();
      d.storage.failNextPut = new Error('offline');
      const id = await d.addOk(original);
      await e().queue.drain();
      await e().store.markFailed(id, 'offline');

      expect(await d.add(original)).toEqual({ id, duplicate: false, restored: false });
      await e().queue.drain();
      expect(e().photo(id).status).toBe('stored');
    });

    it('waits out a rate limit without using up a retry', async () => {
      d.storage.failNextPut = new RateLimitedError(300);
      const id = await d.addOk(makeJpeg());
      await e().queue.drain();
      const row = e().store.getPhoto(id)!;
      expect(row.status).toBe('queued');
      expect(row.attempts).toBe(0);
      expect(row.next_attempt_at).toBeGreaterThan(Date.now() + 200_000);
    });

    it('holds every other upload during a rate limit', async () => {
      d.storage.failNextPut = new RateLimitedError(300);
      const seen: string[] = [];
      d.storage.onPut = (input) => seen.push(input.filename);
      await d.addOk(makeJpeg({ color: '#101010' }), 'a.jpg');
      await e().queue.drain();
      await d.addOk(makeJpeg({ color: '#202020' }), 'b.jpg');
      await e().queue.drain();
      expect(seen).toEqual(['a.jpg']);
    });

    it('pauses and asks for sign-in if the Telegram session is revoked, then resumes', async () => {
      d.storage.failNextPut = new SessionRevokedError('AUTH_KEY_UNREGISTERED');
      const id = await d.addOk(makeJpeg());
      await e().queue.drain();
      await e().whenIdle();
      expect(e().session().account?.needsReauth).toBe(true);
      expect(e().photo(id).status).toBe('queued');
      expect(e().queue.hasFile(id)).toBe(true);

      await d.signIn();
      await e().queue.drain();
      expect(e().session().account?.needsReauth).toBe(false);
      expect(e().photo(id).status).toBe('stored');
    });

    it('turns a revoked session into a request to sign in again when the person is waiting on it', async () => {
      const id = await d.stored(makeJpeg());
      await d.reload();
      d.storage.failReads = new SessionRevokedError('AUTH_KEY_UNREGISTERED');
      await expect(e().original(id)).rejects.toMatchObject({ code: 'REAUTH', status: 401 });
      d.storage.failReads = null;
      expect(e().session().account?.needsReauth).toBe(true);
    });

    it('explains when a stored original has gone from Telegram', async () => {
      const id = await d.stored(makeJpeg());
      await d.reload();
      const ref = { session: SESSION, library: { channelId: 'x', accessHash: '0' } };
      await d.storage.deletePhotos(ref, [e().store.getPhoto(id)!.tg_message_id!]);
      await expect(e().original(id)).rejects.toMatchObject({ code: new OriginalMissingError().code });
    });

    it('can give up on a photo that has not reached Telegram', async () => {
      d.storage.failNextPut = new Error('broken');
      const id = await d.addOk(makeJpeg());
      await e().queue.drain();
      await e().cancelUpload(id);
      expect(d.names()).toEqual([]);
      expect(e().queue.hasFile(id)).toBe(false);
    });

    it('refuses to cancel what is already stored', async () => {
      const id = await d.stored(makeJpeg());
      await expect(e().cancelUpload(id)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('trash', () => {
    let id: number;
    beforeEach(async () => {
      await d.signIn();
      id = await d.stored(makeJpeg());
    });

    it('moving to Trash keeps the Telegram copy, and restoring brings it all back', async () => {
      await e().setTrashed([id], true);
      expect(d.names()).toEqual([]);
      expect(d.names({ view: 'trash' })).toHaveLength(1);
      expect(await d.storage.storedCount(SESSION)).toBe(1);
      await e().setTrashed([id], false);
      expect(d.names()).toHaveLength(1);
      expect(d.names({ view: 'trash' })).toEqual([]);
    });

    it('will not permanently delete a photo that is not in Trash', async () => {
      expect((await e().deleteForever([id])).deleted).toBe(0);
      expect(await d.storage.storedCount(SESSION)).toBe(1);
      expect(d.names()).toHaveLength(1);
    });

    it('permanent delete removes the file from Telegram and everything local', async () => {
      await e().setTrashed([id], true);
      const { sha256: hash } = e().photo(id);
      expect(await e().store.getThumb(hash)).not.toBeNull();
      expect((await e().deleteForever([id])).deleted).toBe(1);
      expect(await d.storage.storedCount(SESSION)).toBe(0);
      expect(() => e().photo(id)).toThrow(/Not found/);
      expect(await e().store.getThumb(hash)).toBeNull();
      expect(await e().store.getPreview(hash)).toBeNull();
    });

    it('keeps the record if Telegram refuses the delete', async () => {
      await e().setTrashed([id], true);
      d.storage.failNextDelete = new Error('telegram said no');
      await expect(e().deleteForever([id])).rejects.toThrow('telegram said no');
      expect(d.names({ view: 'trash' })).toHaveLength(1);
    });

    it('never reuses an id, so a cached thumbnail cannot show the wrong photo', async () => {
      await e().setTrashed([id], true);
      await e().deleteForever([id]);
      await d.reload();
      expect(await d.addOk(makeJpeg({ color: '#123123' }))).toBeGreaterThan(id);
    });

    it('empties the Trash', async () => {
      const other = await d.stored(makeJpeg({ color: '#abcabc' }));
      await e().setTrashed([id, other], true);
      expect((await e().emptyTrash()).deleted).toBe(2);
      expect(await d.storage.storedCount(SESSION)).toBe(0);
    });

    it('purges only what has been in Trash past the retention period', async () => {
      const kept = await d.stored(makeJpeg({ color: '#defdef' }));
      const day = 24 * 60 * 60 * 1000;
      await e().store.setTrashed([id], Date.now() - 31 * day);
      await e().store.setTrashed([kept], Date.now() - 29 * day);
      expect(await e().library.purgeExpired()).toBe(1);
      expect(e().photos({ view: 'trash' }).map((p) => p.id)).toEqual([kept]);
      expect(await d.storage.storedCount(SESSION)).toBe(1);
    });

    it('never purges early, even if Telegram is unreachable on the day', async () => {
      await e().store.setTrashed([id], Date.now() - 31 * 24 * 60 * 60 * 1000);
      d.storage.failNextDelete = new Error('offline');
      expect(await e().library.purgeExpired()).toBe(0);
      expect(d.names({ view: 'trash' })).toHaveLength(1);
    });
  });

  describe('favorites and albums', () => {
    beforeEach(() => d.signIn());

    it('marks favorites', async () => {
      const a = await d.addOk(makeJpeg({ color: '#a0a0a0' }));
      const b = await d.addOk(makeJpeg({ color: '#b0b0b0' }));
      await e().setFavorite([a], true);
      expect(e().photos({ view: 'favorites' }).map((p) => p.id)).toEqual([a]);
      expect(e().photo(a).favorite).toBe(true);
      expect(e().photo(b).favorite).toBe(false);
    });

    it('creates albums, shows covers, hides trashed photos, and never deletes photos with the album', async () => {
      const a = await d.addOk(makeJpeg({ color: '#c0c0c0', date: '2022:01:01 00:00:00' }));
      const b = await d.addOk(makeJpeg({ color: '#d0d0d0', date: '2023:01:01 00:00:00' }));
      const { id: album } = await e().createAlbum('  Holiday  ', [a]);
      await e().addToAlbum(album, [b]);
      await e().addToAlbum(album, [b]); // Adding twice is harmless.

      expect(e().albums()[0]).toMatchObject({ id: album, title: 'Holiday', photoCount: 2, coverId: b });
      expect(e().photos({ album }).map((p) => p.id)).toEqual([b, a]);
      expect(e().photo(a).albums).toEqual([{ id: album, title: 'Holiday' }]);

      await e().updateAlbum(album, { title: 'Trip', coverPhotoId: a });
      expect(e().albums()[0]).toMatchObject({ title: 'Trip', coverId: a });

      await e().setTrashed([a], true);
      expect(e().albums()[0]).toMatchObject({ photoCount: 1, coverId: b });
      expect(e().photos({ album }).map((p) => p.id)).toEqual([b]);

      await e().removeFromAlbum(album, [b]);
      expect(e().photos({ album })).toEqual([]);

      await e().deleteAlbum(album);
      expect(e().albums()).toEqual([]);
      expect(e().photos({}).map((p) => p.id)).toEqual([b]);
    });

    it('requires an album name', async () => {
      await expect(e().createAlbum('   ')).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('uploading straight into an album', () => {
    beforeEach(() => d.signIn());

    const album = async (title = 'Trip') => (await e().createAlbum(title)).id;
    const trashNames = () => d.names({ view: 'trash' });

    it('keeps the photo in its album and out of Photos and search', async () => {
      const id = await album();
      const bytes = makeJpeg({ color: '#101010', date: '2024:03:04 05:06:07' });
      const { id: photo, duplicate } = await d.addInto(id, bytes, 'beach.jpg');
      await e().queue.drain();

      expect(duplicate).toBe(false);
      expect(d.names({ album: id })).toEqual(['beach.jpg']);
      expect(d.names()).toEqual([]);
      expect(d.names({ q: 'beach' })).toEqual([]);
      expect(e().albums()[0]).toMatchObject({ photoCount: 1, coverId: photo, onlyHereCount: 1 });
      expect(e().photo(photo)).toMatchObject({ albumOnly: true, status: 'stored', albums: [{ id, title: 'Trip' }] });
    });

    it('still stores the untouched original in Telegram', async () => {
      const bytes = makeJpeg({ color: '#111111' });
      const { id: photo } = await d.addInto(await album(), bytes);
      await e().queue.drain();
      expect(d.storage.fetchCount).toBe(0);
      expect(e().photo(photo).telegramMessageId).not.toBeNull();
      await d.reload();
      expect(sha256(await blobBytes(await e().original(photo)))).toBe(sha256(bytes));
      expect(d.storage.fetchCount).toBe(1);
    });

    it('leaves photos picked from the library in Photos as well', async () => {
      const id = await album();
      const photo = await d.stored(makeJpeg({ color: '#121212' }), 'kept.jpg');
      await e().addToAlbum(id, [photo]);

      expect(d.names()).toEqual(['kept.jpg']);
      expect(d.names({ album: id })).toEqual(['kept.jpg']);
      expect(e().photo(photo).albumOnly).toBe(false);
      expect(e().albums()[0]!.onlyHereCount).toBe(0);
    });

    it('still shows in Favorites once starred, and returns to its album from Trash', async () => {
      const id = await album();
      const { id: photo } = await d.addInto(id, makeJpeg({ color: '#131313' }), 'star.jpg');
      await e().queue.drain();

      await e().setFavorite([photo], true);
      expect(d.names({ view: 'favorites' })).toEqual(['star.jpg']);

      await e().setTrashed([photo], true);
      expect(trashNames()).toEqual(['star.jpg']);
      expect(d.names({ album: id })).toEqual([]);

      await e().setTrashed([photo], false);
      expect(d.names({ album: id })).toEqual(['star.jpg']);
      expect(d.names()).toEqual([]);
    });

    it('stays out of Photos while any album holds it, and moves there after the last one lets go', async () => {
      const first = await album('First');
      const second = await album('Second');
      const { id: photo } = await d.addInto(first, makeJpeg({ color: '#141414' }), 'both.jpg');
      await e().queue.drain();
      await e().addToAlbum(second, [photo]);
      expect(d.names()).toEqual([]);
      expect(e().album(first).onlyHereCount).toBe(0);

      expect(await e().removeFromAlbum(first, [photo])).toEqual({ movedToPhotos: 0 });
      expect(d.names()).toEqual([]);
      expect(e().album(second).onlyHereCount).toBe(1);

      expect(await e().removeFromAlbum(second, [photo])).toEqual({ movedToPhotos: 1 });
      expect(d.names()).toEqual(['both.jpg']);

      // It is an ordinary library photo now, so adding it to an album again must not hide it.
      await e().addToAlbum(first, [photo]);
      expect(d.names()).toEqual(['both.jpg']);
    });

    it('moves photos only in a deleted album to Trash, and leaves everything else alone', async () => {
      const id = await album('Gone');
      const other = await album('Other');
      const library = await d.stored(makeJpeg({ color: '#151515' }), 'library.jpg');
      await e().addToAlbum(id, [library]);
      const { id: only } = await d.addInto(id, makeJpeg({ color: '#161616' }), 'only.jpg');
      const { id: shared } = await d.addInto(id, makeJpeg({ color: '#171717' }), 'shared.jpg');
      const { id: binned } = await d.addInto(id, makeJpeg({ color: '#181818' }), 'binned.jpg');
      await e().queue.drain();
      await e().addToAlbum(other, [shared]);
      await e().setTrashed([binned], true);
      expect(e().album(id).onlyHereCount).toBe(1);

      expect(await e().deleteAlbum(id)).toEqual({ movedToTrash: 1 });

      expect(d.names()).toEqual(['library.jpg']);
      expect(d.names({ album: other })).toEqual(['shared.jpg']);
      expect(trashNames().sort()).toEqual(['binned.jpg', 'only.jpg']);
      expect(e().photo(shared).albumOnly).toBe(true);

      // Its album has gone, so Photos is the only place left to bring it back to.
      await e().setTrashed([only], false);
      expect(d.names().sort()).toEqual(['library.jpg', 'only.jpg']);
      expect(e().photo(only).albumOnly).toBe(false);
    });

    it('sends nothing new when the file is already in the library, and keeps it in Photos', async () => {
      const id = await album();
      const bytes = makeJpeg({ color: '#191919' });
      const photo = await d.stored(bytes, 'library.jpg');
      const result = await d.addInto(id, bytes, 'copy.jpg');
      await e().queue.drain();

      expect(result).toEqual({ id: photo, duplicate: true, restored: false });
      expect(d.names()).toEqual(['library.jpg']);
      expect(d.names({ album: id })).toEqual(['library.jpg']);
      expect(e().photo(photo).albumOnly).toBe(false);
    });

    it('brings an album-only photo into Photos when the same file is uploaded there', async () => {
      const id = await album();
      const bytes = makeJpeg({ color: '#1a1a1a' });
      const { id: photo } = await d.addInto(id, bytes, 'moved.jpg');
      await e().queue.drain();

      expect(await d.add(bytes, 'moved.jpg')).toEqual({ id: photo, duplicate: true, restored: false });
      expect(d.names()).toEqual(['moved.jpg']);
      expect(d.names({ album: id })).toEqual(['moved.jpg']);
    });

    it('adds a file uploaded twice to a second album without moving it to Photos', async () => {
      const first = await album('First');
      const second = await album('Second');
      const bytes = makeJpeg({ color: '#1b1b1b' });
      const { id: photo } = await d.addInto(first, bytes);
      await e().queue.drain();

      expect((await d.addInto(second, bytes)).id).toBe(photo);
      expect(e().photo(photo).albums.map((a) => a.title).sort()).toEqual(['First', 'Second']);
      expect(d.names()).toEqual([]);
    });

    it('takes a trashed photo out of Trash and into the album only, as that is where it was just put', async () => {
      const id = await album();
      const bytes = makeJpeg({ color: '#1c1c1c' });
      const photo = await d.stored(bytes, 'back.jpg');
      await e().setTrashed([photo], true);

      expect(await d.addInto(id, bytes)).toEqual({ id: photo, duplicate: true, restored: true });
      expect(trashNames()).toEqual([]);
      expect(d.names({ album: id })).toEqual(['back.jpg']);
      expect(d.names()).toEqual([]);
    });

    it('goes to Photos when the album no longer exists', async () => {
      const id = await album();
      await e().deleteAlbum(id);
      await d.addInto(id, makeJpeg({ color: '#1d1d1d' }), 'homeless.jpg');
      expect(d.names()).toEqual(['homeless.jpg']);
    });

    it('stays album-only when an interrupted upload is finished from elsewhere', async () => {
      const id = await album();
      const bytes = makeJpeg({ color: '#1e1e1e' });
      d.storage.putDelayMs = 50;
      const { id: photo } = await d.addInto(id, bytes, 'resume.jpg');
      await d.reload();
      expect(e().photo(photo)).toMatchObject({ status: 'failed', error: INTERRUPTED_MESSAGE });
      expect(d.names()).toEqual([]);

      d.storage.putDelayMs = 0;
      await d.add(bytes, 'resume.jpg');
      await e().queue.drain();
      expect(e().photo(photo).status).toBe('stored');
      expect(d.names()).toEqual([]);
      expect(d.names({ album: id })).toEqual(['resume.jpg']);
    });

    it('never leaves a photo with nowhere to be seen, however its album went away', async () => {
      const id = await album();
      const { id: photo } = await d.addInto(id, makeJpeg({ color: '#1f1f1f' }), 'stranded.jpg');
      await e().queue.drain();
      // What a damaged state file or a half-finished change from elsewhere can leave behind.
      await e().store.deleteAlbum(id);
      expect(d.names()).toEqual(['stranded.jpg']);
      expect(e().photo(photo).albumOnly).toBe(false);

      const other = await album('Other');
      await e().addToAlbum(other, [photo]);
      expect(d.names()).toEqual(['stranded.jpg']);
    });

    it('treats photos saved before this existed as ordinary library photos', async () => {
      const photo = await d.stored(makeJpeg({ color: '#202020' }), 'old.jpg');
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(d.dbName);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      await new Promise<void>((resolve, reject) => {
        const os = db.transaction('photos', 'readwrite').objectStore('photos');
        const read = os.get(photo);
        read.onerror = () => reject(read.error);
        read.onsuccess = () => {
          const { album_only: _gone, ...old } = read.result as Record<string, unknown>;
          const write = os.put(old);
          write.onsuccess = () => resolve();
          write.onerror = () => reject(write.error);
        };
      });
      db.close();

      await d.reload();
      expect(e().store.getPhoto(photo)!.album_only).toBe(false);
      expect(d.names()).toEqual(['old.jpg']);
    });
  });

  describe('downloading many photos', () => {
    it('builds a zip whose contents are byte-identical, with clashing names kept apart', async () => {
      await d.signIn();
      const one = makeJpeg({ color: '#1a1a1a' });
      const two = makeJpeg({ color: '#2b2b2b' });
      const three = makeJpeg({ color: '#3c3c3c' });
      const ids = [await d.addOk(one, 'same.jpg'), await d.addOk(two, 'same.jpg'), await d.addOk(three, 'other.jpg')];
      await e().queue.drain();

      const response = zipOf(e(), e().photosForDownload(ids));
      const dir = mkdtempSync(join(tmpdir(), 'tp-zip-'));
      try {
        const zip = join(dir, 'a.zip');
        writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
        execFileSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, dir]);
        const names = readdirSync(dir).filter((n) => n.endsWith('.jpg')).sort();
        expect(names).toEqual(['other.jpg', 'same (1).jpg', 'same.jpg']);
        expect(names.map((n) => sha256(readFileSync(join(dir, n)))).sort()).toEqual([one, two, three].map((b) => sha256(b)).sort());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('refuses more than it can reasonably build', async () => {
      await d.signIn();
      expect(() => e().photosForDownload(Array.from({ length: 2001 }, (_, i) => i))).toThrow(/2,000/);
    });
  });

  describe('when the tab closes mid-upload', () => {
    beforeEach(() => d.signIn());

    it('says what happened, keeps the record, and loses nothing already stored', async () => {
      const safe = await d.stored(makeJpeg({ color: '#0f0f0f' }), 'safe.jpg');
      d.storage.failNextPut = new Error('stop');
      const id = await d.addOk(makeJpeg({ color: '#9a9a9a' }), 'unfinished.jpg');
      await e().queue.drain();
      await d.reload();
      expect(e().photo(safe).status).toBe('stored');
      expect(e().photo(id)).toMatchObject({ status: 'failed', error: INTERRUPTED_MESSAGE });
      expect(e().hasUploadsInProgress).toBe(false);
    });

    it('explains that the file is needed rather than pretending a retry can work', async () => {
      d.storage.failNextPut = new Error('stop');
      const id = await d.addOk(makeJpeg());
      await e().queue.drain();
      await d.reload();
      await expect(e().retryUploads([id])).rejects.toMatchObject({ code: 'FILE_NEEDED' });
      await expect(e().retryUploads()).rejects.toMatchObject({ code: 'FILE_NEEDED' });
      expect(e().uploadStatus().items[0]).toMatchObject({ id, needsFile: true });
      expect(e().photo(id).status).toBe('failed');
    });

    it('gives a reselected file a fresh retry budget after a reload', async () => {
      const original = makeJpeg();
      d.storage.failNextPut = new Error('offline');
      const id = await d.addOk(original);
      await e().queue.drain();
      for (let i = 0; i < 5; i++) await e().store.markFailed(id, 'offline');
      expect(e().store.getPhoto(id)!.attempts).toBe(6);
      await d.reload();

      d.storage.failNextPut = new Error('one more network error');
      expect(await e().ingest(new Blob([original as BlobPart]), 'photo.jpg', null, undefined, { retryOnly: true }))
        .toEqual({ id, duplicate: false, restored: false });
      await e().queue.drain();
      expect(e().store.getPhoto(id)).toMatchObject({ status: 'queued', attempts: 1 });
      expect(e().uploadStatus().items[0]).toMatchObject({ id, needsFile: false });

      e().store.getPhoto(id)!.next_attempt_at = 0;
      await e().queue.drain();
      expect(e().photo(id).status).toBe('stored');
    });

    it('lets the whole original batch be reselected without changing albums or restoring Trash', async () => {
      const album = await e().createAlbum('Trip');
      const originals = Array.from({ length: 3 }, (_, i) => makeJpeg({ color: `retry-${i}` }));
      const safe = (await d.addInto(album.id, originals[0]!)).id;
      await e().queue.drain();
      const trashed = await d.stored(originals[1]!);
      await e().setTrashed([trashed], true);
      d.storage.failNextPut = new Error('offline');
      const pending = (await d.addInto(album.id, originals[2]!)).id;
      await e().queue.drain();
      await d.reload();

      for (const original of originals) {
        await e().ingest(new Blob([original as BlobPart]), 'photo.jpg', null, undefined, { retryOnly: true });
      }
      await e().queue.drain();
      expect(e().photo(safe).albumOnly).toBe(true);
      expect(e().photo(trashed).trashedAt).not.toBeNull();
      expect(e().photo(pending)).toMatchObject({ status: 'stored', albumOnly: true });
      expect(e().album(album.id).photoCount).toBe(2);
      expect(await d.storage.storedCount(SESSION)).toBe(3);
    });

    it('asks for the original if a different photo is selected for a retry', async () => {
      await expect(e().ingest(new Blob([makeJpeg() as BlobPart]), 'wrong.jpg', null, undefined, { retryOnly: true }))
        .rejects.toMatchObject({ code: 'NOT_AN_UPLOAD' });
      expect(d.names()).toEqual([]);
    });

    it('picks up where it left off when the same file is added again', async () => {
      d.storage.failNextPut = new Error('stop');
      const original = makeJpeg({ color: '#9a9a9a' });
      const id = await d.addOk(original);
      await e().queue.drain();
      await d.reload();

      const again = await d.add(original);
      expect(again).toEqual({ id, duplicate: false, restored: false });
      await e().queue.drain();
      expect(e().photo(id).status).toBe('stored');
      expect(sha256(await blobBytes(await e().original(id)))).toBe(sha256(original));
    });
  });

  describe('rebuilding from Telegram', () => {
    it('restores the whole library after this browser loses everything', async () => {
      await d.signIn();
      const original = makeJpeg({ width: 1200, height: 800, date: '2018:05:06 07:08:09', camera: 'EOS R5', color: '#5e5e5e' });
      const other = makeJpeg({ width: 640, height: 480, date: '2017:01:02 03:04:05', color: '#6f6f6f' });
      const keep = await d.addOk(original, 'keep.jpg');
      await d.addOk(other, 'also.jpg');
      await e().queue.drain();
      await e().setFavorite([keep], true);
      const { id: album } = await e().createAlbum('Trip', [keep]);
      expect(album).toBeGreaterThan(0);
      await d.saveState();

      await d.wipeBrowser();
      expect(e().session().account).toBeNull();
      d.storage.fetchCount = 0;
      await d.signIn();

      expect(d.names()).toEqual(['keep.jpg', 'also.jpg']);
      const restored = e().photos({})[0]!;
      const detail = e().photo(restored.id);
      expect(detail).toMatchObject({ takenAt: '2018-05-06T07:08:09', width: 1200, height: 800, status: 'stored', previewState: 'ready', sha256: sha256(original), favorite: true });
      expect(detail.camera.model).toBe('EOS R5');
      expect(e().albums()[0]).toMatchObject({ title: 'Trip', photoCount: 1, coverId: restored.id });

      // The point of storing a thumbnail with each photo: nothing large had to come down.
      const thumb = await e().thumb(restored.id);
      expect(new TextDecoder().decode(await blobBytes(thumb!))).toBe('telegram-thumb');
      expect(d.storage.fetchCount).toBe(0);

      expect(sha256(await blobBytes(await e().original(restored.id)))).toBe(sha256(original));
      expect(d.storage.fetchCount).toBe(1);
    });

    it('asks Telegram for a thumbnail only once', async () => {
      await d.signIn();
      await d.stored(makeJpeg());
      await d.wipeBrowser();
      await d.signIn();
      const { id } = e().photos({})[0]!;
      d.storage.thumbFetchCount = 0;
      await e().thumb(id);
      await e().thumb(id);
      expect(d.storage.thumbFetchCount).toBe(1);
    });

    it('builds a thumbnail from the original for a photo Telegram has none for', async () => {
      await d.signIn();
      const bytes = makeJpeg({ color: '#808080' });
      const caption = buildCaption({ filename: 'old.jpg', sha256: sha256(bytes), takenAt: '2010-01-01T00:00:00', width: 64, height: 48 });
      await d.storage.inject(SESSION, { filename: 'old.jpg', size: bytes.length, mime: 'image/jpeg', caption, hasThumb: false, file: new Blob([bytes as BlobPart]), thumb: null });
      await d.catchUp();
      const { id } = e().photos({})[0]!;
      expect(e().photo(id).previewState).toBe('ready');
      expect(await e().thumb(id)).not.toBeNull();
    });

    it('only asks for what is new when catching up', async () => {
      await d.signIn();
      await d.stored(makeJpeg({ color: '#aaaaaa' }));
      await d.catchUp();
      const asked: (number | undefined)[] = [];
      const original = d.storage.scanLibrary.bind(d.storage);
      d.storage.scanLibrary = ((ctx, options) => {
        asked.push(options?.afterMessageId);
        return original(ctx, options);
      }) as typeof d.storage.scanLibrary;
      await d.catchUp();
      expect(asked).toEqual([1]);
    });

    it('rescanning adds nothing new, and ignores messages it did not write', async () => {
      await d.signIn();
      await d.stored(makeJpeg());
      await d.storage.inject(SESSION, { filename: 'holiday-note.pdf', size: 4, mime: 'application/pdf', caption: 'just a note I posted', hasThumb: false, file: new Blob(['note']), thumb: null });
      e().rescan();
      await e().library.settled();
      expect(e().library.scanState()).toMatchObject({ scanned: 1, added: 0, error: null });
      expect(d.names()).toHaveLength(1);
    });

    it('cleans the name of a restored photo, as it would an uploaded one', async () => {
      await d.signIn();
      const bytes = makeJpeg({ color: '#909090' });
      const caption = buildCaption({ filename: 'x', sha256: sha256(bytes), takenAt: '2010-01-01T00:00:00', width: 64, height: 48 });
      await d.storage.inject(SESSION, { filename: '../../evil.jpg', size: bytes.length, mime: 'image/jpeg', caption, hasThumb: true, file: new Blob([bytes as BlobPart]), thumb: new Blob(['t']) });
      await d.catchUp();
      expect(d.names()).toEqual(['evil.jpg']);
    });

    it('reports a failed scan without losing what it found', async () => {
      await d.signIn();
      await d.stored(makeJpeg());
      d.storage.failReads = new Error('offline');
      e().rescan();
      await e().library.settled();
      d.storage.failReads = null;
      expect(e().library.scanState().error).toBe('offline');
      expect(d.names()).toHaveLength(1);
    });
  });

  describe('captions', () => {
    const hash = 'a'.repeat(64);

    it('round-trips the facts needed for a rebuild', () => {
      const caption = buildCaption({ filename: 'IMG 1.jpg', sha256: hash, takenAt: '2024-07-01T18:22:10', width: 4032, height: 3024 });
      expect(parseCaption(caption)).toEqual({ sha256: hash, takenAt: '2024-07-01T18:22:10', width: 4032, height: 3024 });
      expect(caption).toContain('#y2024_07');
    });

    it("stays within Telegram's 1024 character limit, with the marker intact", () => {
      const caption = buildCaption({ filename: 'x'.repeat(5000), sha256: hash, takenAt: '2024-07-01T18:22:10', width: null, height: null });
      expect(caption.length).toBeLessThanOrEqual(1024);
      expect(parseCaption(caption)?.sha256).toBe(hash);
    });

    it('is not fooled by a filename that imitates the marker', () => {
      const evil = `telephoto:v1 sha256=${'b'.repeat(64)} taken=1999-01-01T00:00:00`;
      const caption = buildCaption({ filename: evil, sha256: hash, takenAt: '2024-07-01T18:22:10', width: 1, height: 1 });
      expect(parseCaption(caption)?.sha256).toBe(hash);
    });

    it('ignores captions it did not write', () => {
      expect(parseCaption('holiday pics')).toBeNull();
      expect(parseCaption('')).toBeNull();
    });
  });

  it('marks fake storage so the UI can warn about it', () => {
    expect(e().session().storage).toBe('fake');
    expect(d.storage).toBeInstanceOf(FakeStorage);
  });
});
