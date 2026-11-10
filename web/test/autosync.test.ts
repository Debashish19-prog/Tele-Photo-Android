import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AndroidBridge, androidGallery, GalleryFile } from '../src/engine/android';
import {
  AutoSync, type AutoSyncStatus, type GalleryAccess, type GalleryHost, type GalleryItem, GalleryLedger, GalleryReadError, type NetworkState, type PassOutcome,
} from '../src/engine/autosync';
import { RateLimitedError, SessionRevokedError } from '../src/engine/types';
import { blobBytes, Device, makeJpeg, makeMp4, sha256 } from './helpers';

const LONG_AGO = 1_700_000_000;
let ledgerCount = 0;

/** A pretend phone. Reads hand over the same bytes it was given, and it counts them. */
class FakeGallery implements GalleryHost {
  files = new Map<number, { item: GalleryItem; bytes: Uint8Array }>();
  reads: number[] = [];
  outcomes: PassOutcome[] = [];
  reports: AutoSyncStatus[] = [];
  accessNow: GalleryAccess = 'all';
  networkNow: NetworkState = 'unmetered';
  mobileData = false;
  enabled = true;
  readProblem = new Map<number, GalleryReadError>();
  onRead: ((id: number) => void) | null = null;
  private nextId = 1;

  add(bytes: Uint8Array, name = `IMG_${this.nextId}.jpg`, modified = LONG_AGO): number {
    const id = this.nextId++;
    const kind = /\.(mp4|mov)$/i.test(name) ? 'video' : 'photo';
    this.files.set(id, { item: { id, name, size: bytes.length, modified, taken: null, kind }, bytes });
    return id;
  }

  edit(id: number, bytes: Uint8Array): void {
    const file = this.files.get(id)!;
    this.files.set(id, { item: { ...file.item, size: bytes.length, modified: file.item.modified + 100 }, bytes });
  }

  access = () => this.accessNow;
  network = () => this.networkNow;
  settings = () => ({ enabled: this.enabled, mobileData: this.mobileData });
  turnOff = () => {
    this.enabled = false;
  };
  list = async () => [...this.files.values()].map((f) => f.item);
  report = (status: AutoSyncStatus) => void this.reports.push(status);
  finished = (outcome: PassOutcome) => void this.outcomes.push(outcome);

  read = async (item: GalleryItem) => {
    this.reads.push(item.id);
    this.onRead?.(item.id);
    const problem = this.readProblem.get(item.id);
    if (problem) throw problem;
    return new Blob([this.files.get(item.id)!.bytes as BlobPart], { type: 'application/octet-stream' });
  };

  get last(): PassOutcome {
    return this.outcomes[this.outcomes.length - 1]!;
  }
}

describe('automatic gallery backup', () => {
  let d: Device;
  let gallery: FakeGallery;
  let ledger: GalleryLedger;
  let sync: AutoSync;
  let ledgerName: string;

  const start = async () => {
    ledger = await GalleryLedger.open(ledgerName);
    sync = new AutoSync(d.engine, gallery, ledger);
  };
  /** The page goes away, as when Android ends the process. The phone and Telegram stay as they are. */
  const restartApp = async () => {
    await sync.settled();
    ledger.close();
    await d.reload();
    await start();
  };
  const pass = async () => {
    await sync.run();
    await sync.settled();
    return gallery.last;
  };
  const stored = () => d.engine.store.allPhotos().filter((p) => p.status === 'stored');
  const inTelegram = async (id: number) => blobBytes(await d.engine.original(id));

  beforeEach(async () => {
    d = await new Device().open();
    await d.signIn();
    gallery = new FakeGallery();
    ledgerName = `tp-gallery-test-${process.pid}-${++ledgerCount}`;
    await start();
  });

  afterEach(async () => {
    await sync.settled();
    ledger.close();
    await d.close();
  });

  describe('original quality', () => {
    it('stores every photo with exactly the bytes on the phone, in the newest-first order', async () => {
      const photos = [makeJpeg({ color: '#a' }), makeJpeg({ color: '#b', date: '2024:05:01 09:30:00', camera: 'Pixel' }), makeJpeg({ color: '#c' })];
      const ids = photos.map((p) => gallery.add(p));

      expect(await pass()).toMatchObject({ phase: 'idle', remaining: 0 });

      expect(gallery.reads).toEqual([...ids].reverse());
      expect(stored()).toHaveLength(3);
      for (const bytes of photos) {
        const row = d.engine.store.getPhotoBySha(sha256(bytes))!;
        expect(row.status).toBe('stored');
        expect(row.size).toBe(bytes.length);
        d.engine.queue.detach(row.id);
        // Read back from the pretend Telegram, not from a copy held on to by the queue.
        expect(sha256(await inTelegram(row.id))).toBe(sha256(bytes));
      }
    });

    it('keeps the date in the photo itself over what the phone reports', async () => {
      gallery.add(makeJpeg({ color: '#d', date: '2021:02:03 04:05:06' }));
      await pass();
      expect(stored()[0]).toMatchObject({ taken_at: '2021-02-03T04:05:06', taken_source: 'exif' });
    });

    it('uploads nothing at all when Android refuses the original, rather than a copy without its location', async () => {
      const id = gallery.add(makeJpeg({ color: '#e' }));
      gallery.readProblem.set(id, new GalleryReadError('denied', 'no original'));
      expect(await pass()).toMatchObject({ phase: 'no-access' });
      expect(d.engine.store.allPhotos()).toHaveLength(0);
    });

    it('still stores the original when its thumbnail keeps crashing the page', async () => {
      await pass();
      const bytes = makeJpeg({ color: '#huge' });
      const id = gallery.add(bytes);
      // Two runs that died while preparing it, as the page being killed would leave things.
      await ledger.put({ id, modified: LONG_AGO, size: bytes.length, state: 'retry', sha256: null, reason: null, attempts: 0, nextTry: 0, preparing: 2 });

      await pass();

      const row = stored()[0]!;
      expect(row.sha256).toBe(sha256(bytes));
      expect(row.preview_state).toBe('unavailable');
    });
  });

  describe('videos', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /**
     * Reads go through android.ts to a pretend WebAssets.kt, as on the phone, instead of being handed
     * over whole. Returns every request made, which `onRequest` sees first, before it is answered.
     */
    const readFromPhone = (onRequest: (url: string) => void = () => undefined): string[] => {
      const requests: string[] = [];
      vi.stubGlobal('fetch', async (input: string) => {
        requests.push(input);
        onRequest(input);
        const url = new URL(input, 'https://appassets.androidplatform.net');
        const file = gallery.files.get(Number(url.pathname.replace('/_gallery/', '')));
        if (!file || url.searchParams.has('poster')) return new Response(null, { status: 404 });
        const version = `${file.bytes.length}-${file.item.modified}`;
        const headers = { 'X-Tele-Photo-Size': String(file.bytes.length), 'X-Tele-Photo-Version': version };
        const expected = url.searchParams.get('version');
        if (expected !== null && expected !== version) return new Response(null, { status: 409 });
        if (!url.searchParams.has('start')) return new Response(file.bytes as BodyInit, { headers });
        const [start, end] = [Number(url.searchParams.get('start')), Number(url.searchParams.get('end'))];
        if (end > file.bytes.length) return new Response(null, { status: 416 });
        return new Response(file.bytes.slice(start, end) as BodyInit, { headers });
      });
      const phone = androidGallery({} as AndroidBridge);
      gallery.read = async (item) => {
        gallery.reads.push(item.id);
        return phone.read(item);
      };
      return requests;
    };
    const asked = (request: string) => new URLSearchParams(request.split('?')[1] ?? '');

    it('reads a video straight from the phone a piece at a time, never the whole of it at once', async () => {
      const requests = readFromPhone();
      const video = makeMp4({ size: 20 * 1024 * 1024, seed: 12 });
      gallery.add(video, 'VID_direct.mp4');

      expect(await pass()).toMatchObject({ phase: 'idle', remaining: 0 });

      const row = d.engine.store.getPhotoBySha(sha256(video))!;
      expect(row).toMatchObject({ status: 'stored', size: video.length, mime: 'video/mp4' });
      d.engine.queue.detach(row.id);
      expect(sha256(await inTelegram(row.id))).toBe(sha256(video));
      const reads = requests.filter((r) => !asked(r).has('poster'));
      expect(reads.filter((r) => !asked(r).has('start'))).toEqual([]);
      const largest = Math.max(...reads.map((r) => Number(asked(r).get('end')) - Number(asked(r).get('start'))));
      expect(largest).toBeLessThanOrEqual(8 * 1024 * 1024);
      // Each one says which version it expects, apart from the first, which is how it learns that.
      expect(reads.slice(1).every((r) => asked(r).has('version'))).toBe(true);
    });

    it('still reads a photo whole, as its thumbnail needs all of it', async () => {
      const requests = readFromPhone();
      const photo = makeJpeg({ color: '#v3' });
      gallery.add(photo);
      await pass();
      expect(requests).toEqual(['/_gallery/1']);
      expect(d.engine.store.getPhotoBySha(sha256(photo))?.status).toBe('stored');
    });

    it('backs up the new version if a video is edited while it is being read', async () => {
      const first = makeMp4({ size: 20 * 1024 * 1024, seed: 13 });
      const second = makeMp4({ size: 20 * 1024 * 1024 + 7, seed: 14 });
      let id = 0;
      const requests = readFromPhone(() => {
        if (requests.length === 3) gallery.edit(id, second);
      });
      id = gallery.add(first, 'VID_edit.mp4');

      expect(await pass()).toMatchObject({ phase: 'idle', remaining: 0 });

      expect(requests.some((r) => asked(r).has('version'))).toBe(true);
      expect(d.engine.store.getPhotoBySha(sha256(first))).toBeUndefined();
      const row = d.engine.store.getPhotoBySha(sha256(second))!;
      expect(row.status).toBe('stored');
      d.engine.queue.detach(row.id);
      expect(sha256(await inTelegram(row.id))).toBe(sha256(second));
    });

    it('backs up the new version if a video is edited while it is going up, and never mixes the two', async () => {
      readFromPhone();
      const first = makeMp4({ size: 6000, seed: 15 });
      const second = makeMp4({ size: 6500, seed: 16 });
      const id = gallery.add(first, 'VID_edit2.mp4');
      d.storage.onPut = () => {
        d.storage.onPut = null;
        gallery.edit(id, second);
      };

      expect(await pass()).toMatchObject({ phase: 'idle', remaining: 0 });

      const row = d.engine.store.getPhotoBySha(sha256(second))!;
      expect(row.status).toBe('stored');
      d.engine.queue.detach(row.id);
      expect(sha256(await inTelegram(row.id))).toBe(sha256(second));
      // The first version never reached Telegram, and says why.
      expect(d.engine.store.getPhotoBySha(sha256(first))).toMatchObject({ status: 'failed', tg_message_id: null });
      expect(d.engine.store.getPhotoBySha(sha256(first))!.last_error).toContain('changed');
    });

    it('gives up on a video that is deleted from the phone partway, without storing part of it', async () => {
      const video = makeMp4({ size: 20 * 1024 * 1024, seed: 17 });
      let id = 0;
      const requests = readFromPhone(() => {
        if (requests.length === 3) gallery.files.delete(id);
      });
      id = gallery.add(video, 'VID_gone.mp4');

      await pass();

      expect(d.engine.store.allPhotos()).toHaveLength(0);
      expect(sync.status().total).toBe(0);
    });

    it('slices exactly as a Blob does, from either end', async () => {
      readFromPhone();
      const bytes = makeMp4({ size: 5000, seed: 18 });
      const id = gallery.add(bytes, 'VID_slice.mp4');
      const file = new GalleryFile({ id, size: bytes.length, version: `${bytes.length}-${LONG_AGO}` });
      const real = new Blob([bytes as BlobPart]);
      const cases: [number | undefined, number | undefined][] = [[undefined, undefined], [0, 10], [10, 4], [-100, undefined], [-100, -20], [4000, 99_999]];
      for (const [start, end] of cases) {
        const ours = file.slice(start, end);
        expect(ours.size).toBe(real.slice(start, end).size);
        expect(new Uint8Array(await ours.arrayBuffer())).toEqual(new Uint8Array(await real.slice(start, end).arrayBuffer()));
        expect(new Uint8Array(await ours.slice(1, -1).arrayBuffer())).toEqual(new Uint8Array(await real.slice(start, end).slice(1, -1).arrayBuffer()));
      }
    });

    it('backs up a video from the gallery with exactly its bytes, alongside the photos', async () => {
      const photo = makeJpeg({ color: '#v1' });
      const video = makeMp4({ size: 4000, seed: 7 });
      gallery.add(photo);
      gallery.add(video, 'VID_20240101_120000.mp4');

      expect(await pass()).toMatchObject({ phase: 'idle', remaining: 0 });

      const row = d.engine.store.getPhotoBySha(sha256(video))!;
      expect(row).toMatchObject({ status: 'stored', mime: 'video/mp4', size: video.length, tg_parts: null });
      d.engine.queue.detach(row.id);
      expect(sha256(await inTelegram(row.id))).toBe(sha256(video));
      expect(d.engine.store.getPhotoBySha(sha256(photo))?.status).toBe('stored');
    });

    it('sends a video too large for one message in pieces, and the same bytes come back', async () => {
      await sync.settled();
      ledger.close();
      await d.close();
      d = await new Device().open({ split: { maxSingleBytes: 5000, pieceBytes: 3000 } });
      await d.signIn();
      await start();
      const video = makeMp4({ size: 8000, seed: 8 });
      gallery.add(video, 'VID_long.mp4');

      expect(await pass()).toMatchObject({ phase: 'idle', remaining: 0 });

      const row = d.engine.store.getPhotoBySha(sha256(video))!;
      expect(row.status).toBe('stored');
      expect(row.tg_parts).toHaveLength(3);
      d.engine.queue.detach(row.id);
      expect(sha256(await inTelegram(row.id))).toBe(sha256(video));
    });

    it('notes that it is reading a file before it starts, in case reading it is what takes the page down', async () => {
      const video = makeMp4({ size: 3000, seed: 10 });
      const id = gallery.add(video, 'VID_read.mp4');
      let duringRead: number | undefined;
      gallery.onRead = (readId) => {
        if (readId === id) duringRead = ledger.get(id)?.preparing;
      };

      await pass();

      expect(duringRead).toBe(1);
      expect(ledger.get(id)).toMatchObject({ state: 'done', preparing: 0 });
    });

    it('sets aside a file that keeps taking the page down, so the rest of the gallery still gets done', async () => {
      // The first pass claims the ledger for this account, which would clear what is planted below.
      await pass();
      const photo = makeJpeg({ color: '#v2' });
      gallery.add(photo);
      // The newest, so it would be first in line every time.
      const video = makeMp4({ size: 3000, seed: 11 });
      const stuck = gallery.add(video, 'VID_stuck.mp4');
      await ledger.put({ id: stuck, modified: LONG_AGO, size: video.length, state: 'retry', sha256: null, reason: null, attempts: 0, nextTry: 0, preparing: 4 });

      const outcome = await pass();

      expect(gallery.reads).not.toContain(stuck);
      expect(d.engine.store.getPhotoBySha(sha256(photo))?.status).toBe('stored');
      const row = ledger.get(stuck)!;
      expect(row).toMatchObject({ state: 'retry', preparing: 0, attempts: 1 });
      expect(outcome).toMatchObject({ phase: 'idle', resumeAt: row.nextTry });
      expect(sync.status().failing).toBe(1);
    });
  });

  describe('not doing work twice', () => {
    it('does not read unchanged files again', async () => {
      gallery.add(makeJpeg({ color: '#1' }));
      gallery.add(makeJpeg({ color: '#2' }));
      await pass();
      gallery.reads.length = 0;
      await pass();
      expect(gallery.reads).toEqual([]);
    });

    it('only reads what is new', async () => {
      gallery.add(makeJpeg({ color: '#1' }));
      await pass();
      gallery.reads.length = 0;
      const added = gallery.add(makeJpeg({ color: '#2' }));
      await pass();
      expect(gallery.reads).toEqual([added]);
      expect(stored()).toHaveLength(2);
    });

    it('backs up an edited photo as a new one and keeps the first', async () => {
      const id = gallery.add(makeJpeg({ color: '#before' }));
      await pass();
      gallery.edit(id, makeJpeg({ color: '#after!' }));
      await pass();
      expect(stored()).toHaveLength(2);
    });

    it('stores the same bytes once, even as two files on the phone', async () => {
      const bytes = makeJpeg({ color: '#same' });
      gallery.add(bytes, 'one.jpg');
      gallery.add(bytes, 'copy.jpg');
      expect(await pass()).toMatchObject({ phase: 'idle' });
      expect(stored()).toHaveLength(1);
      expect(sync.status().done).toBe(2);
    });

    it('recognises photos already in Telegram after the app is reinstalled, without sending them again', async () => {
      gallery.add(makeJpeg({ color: '#1' }));
      gallery.add(makeJpeg({ color: '#2' }));
      await pass();
      const session = d.engine.store.account!.session!;
      const sent = await d.storage.storedCount(session);
      expect(sent).toBeGreaterThanOrEqual(2);

      ledger.close();
      ledgerName = `${ledgerName}-reinstalled`;
      await d.wipeBrowser();
      await d.signIn();
      await start();
      await pass();

      expect(gallery.reads).toHaveLength(4);
      expect(await d.storage.storedCount(d.engine.store.account!.session!)).toBe(sent);
      expect(sync.status()).toMatchObject({ done: 2, remaining: 0 });
    });
  });

  describe('respecting what the person did', () => {
    const storedOnly = async () => {
      const bytes = makeJpeg({ color: '#kept' });
      gallery.add(bytes);
      await pass();
      return { bytes, row: stored()[0]! };
    };

    it('does not bring back a photo moved to Trash, even with no memory of the phone', async () => {
      const { row } = await storedOnly();
      await d.engine.setTrashed([row.id], true);
      await ledger.clear();
      await pass();
      expect(d.engine.store.getPhoto(row.id)?.trashed_at).not.toBeNull();
    });

    it('does not upload a photo deleted for good again', async () => {
      const { row, bytes } = await storedOnly();
      await d.engine.setTrashed([row.id], true);
      await d.engine.deleteForever([row.id]);
      await ledger.clear();

      expect(await pass()).toMatchObject({ phase: 'idle' });

      expect(d.engine.store.getPhotoBySha(sha256(bytes))).toBeUndefined();
      expect(sync.status().done).toBe(1);
    });

    it('does not forget a photo deleted for good if the app ends straight after', async () => {
      const { row, bytes } = await storedOnly();
      await d.engine.setTrashed([row.id], true);
      await d.engine.sync.flush();
      await d.engine.deleteForever([row.id]);

      // Sooner than the save that was due a few seconds later.
      await restartApp();
      expect(d.engine.sync.isDeleted(sha256(bytes))).toBe(true);

      // It still reaches Telegram, so that a fresh install knows about it as well.
      await d.engine.whenIdle();
      await d.engine.sync.flush();
      const sent = await d.storage.storedCount(d.engine.store.account!.session!);
      ledger.close();
      ledgerName = `${ledgerName}-reinstalled`;
      await d.wipeBrowser();
      await d.signIn();
      await start();
      await pass();

      expect(d.engine.store.getPhotoBySha(sha256(bytes))).toBeUndefined();
      expect(await d.storage.storedCount(d.engine.store.account!.session!)).toBe(sent);
    });

    it('leaves a photo in its album only, rather than pulling it into Photos', async () => {
      const { id: albumId } = await d.engine.createAlbum('Private');
      const bytes = makeJpeg({ color: '#album' });
      const { id } = await d.addInto(albumId, bytes);
      await d.engine.queue.drain();

      gallery.add(bytes);
      await pass();

      expect(d.engine.store.getPhoto(id)?.album_only).toBe(true);
      expect(d.names()).toEqual([]);
    });

    it('keeps the backup when the photo leaves the phone', async () => {
      const id = gallery.add(makeJpeg({ color: '#leaving' }));
      await pass();
      gallery.files.delete(id);
      await pass();
      expect(stored()).toHaveLength(1);
    });

    it('does nothing while turned off', async () => {
      gallery.enabled = false;
      gallery.add(makeJpeg({ color: '#off' }));
      expect(await pass()).toMatchObject({ phase: 'off' });
      expect(gallery.reads).toEqual([]);
    });

    it('does not touch anything without access to the photos', async () => {
      gallery.accessNow = 'none';
      gallery.add(makeJpeg({ color: '#none' }));
      expect(await pass()).toMatchObject({ phase: 'no-access' });
      expect(gallery.reads).toEqual([]);
    });

    it('backs up what it can see with partial access', async () => {
      gallery.accessNow = 'partial';
      gallery.add(makeJpeg({ color: '#partial' }));
      expect(await pass()).toMatchObject({ phase: 'idle' });
      expect(stored()).toHaveLength(1);
    });
  });

  describe('the network', () => {
    it('stays off mobile data unless it is allowed, and carries on when it is', async () => {
      gallery.networkNow = 'metered';
      gallery.add(makeJpeg({ color: '#w' }));
      expect(await pass()).toMatchObject({ phase: 'waiting-network', remaining: 1 });
      expect(gallery.reads).toEqual([]);

      gallery.mobileData = true;
      expect(await pass()).toMatchObject({ phase: 'idle', remaining: 0 });
      expect(stored()).toHaveLength(1);
    });

    it('waits for a connection', async () => {
      gallery.networkNow = 'none';
      gallery.mobileData = true;
      gallery.add(makeJpeg({ color: '#o' }));
      expect(await pass()).toMatchObject({ phase: 'waiting-network' });
    });

    it('stops at once when Wi-Fi goes away partway through', async () => {
      gallery.add(makeJpeg({ color: '#1' }));
      gallery.add(makeJpeg({ color: '#2' }));
      gallery.add(makeJpeg({ color: '#3' }));
      gallery.onRead = () => {
        if (gallery.reads.length === 2) gallery.networkNow = 'metered';
      };
      expect(await pass()).toMatchObject({ phase: 'waiting-network' });
      expect(gallery.reads.length).toBe(2);
    });
  });

  describe('when things go wrong', () => {
    const failUploads = (make: () => Error) => {
      const real = d.storage.putPhoto.bind(d.storage);
      d.storage.putPhoto = async () => {
        throw make();
      };
      return () => {
        d.storage.putPhoto = real;
      };
    };

    it('picks an interrupted backup back up after the app restarts, with no help', async () => {
      const a = makeJpeg({ color: '#1' });
      const b = makeJpeg({ color: '#2' });
      gallery.add(a);
      gallery.add(b);
      const restore = failUploads(() => new RateLimitedError(9999));
      const outcome = await pass();
      expect(outcome.phase).toBe('rate-limited');
      expect(d.engine.store.allPhotos().filter((p) => p.status === 'stored')).toHaveLength(0);

      restore();
      await ledger.setMeta('blockedUntil', 0);
      await restartApp();
      expect(await pass()).toMatchObject({ phase: 'idle', remaining: 0 });
      expect(stored().map((p) => p.sha256).sort()).toEqual([sha256(a), sha256(b)].sort());
    });

    it('stops when Telegram asks it to wait a long time, remembers that, and uses no attempts', async () => {
      gallery.add(makeJpeg({ color: '#f' }));
      const restore = failUploads(() => new RateLimitedError(3600));

      const outcome = await pass();

      expect(outcome.phase).toBe('rate-limited');
      expect(outcome.resumeAt).toBeGreaterThan(Date.now() + 3000 * 1000);
      expect(d.engine.store.allPhotos()[0]!.attempts).toBe(0);

      // Starting again before then must not touch Telegram, even after a restart.
      restore();
      gallery.reads.length = 0;
      await restartApp();
      expect(await pass()).toMatchObject({ phase: 'rate-limited' });
      expect(gallery.reads).toEqual([]);
    });

    it('stops and asks to sign in when Telegram ends the session', async () => {
      gallery.add(makeJpeg({ color: '#r' }));
      const restore = failUploads(() => new SessionRevokedError('AUTH_KEY_UNREGISTERED'));
      expect(await pass()).toMatchObject({ phase: 'needs-sign-in' });
      restore();
      expect(await pass()).toMatchObject({ phase: 'needs-sign-in' });
    });

    it('refuses a file that is not a photo once, and moves on to the rest', async () => {
      const bad = gallery.add(new TextEncoder().encode('this is not an image at all, it only has the name of one'), 'fake.jpg');
      gallery.add(makeJpeg({ color: '#good' }));
      expect(await pass()).toMatchObject({ phase: 'idle' });
      expect(sync.status()).toMatchObject({ refused: 1, done: 1, remaining: 0 });

      gallery.reads.length = 0;
      await pass();
      expect(gallery.reads).not.toContain(bad);
      expect(sync.status()).toMatchObject({ refused: 1, done: 1 });
    });

    it('tries a file again when it could not be read, then moves on', async () => {
      const bad = gallery.add(makeJpeg({ color: '#bad' }));
      gallery.add(makeJpeg({ color: '#ok' }));
      gallery.readProblem.set(bad, new GalleryReadError('failed', 'disk trouble'));

      const outcome = await pass();

      expect(outcome.phase).toBe('idle');
      expect(outcome.resumeAt).toBeGreaterThan(Date.now());
      expect(sync.status()).toMatchObject({ done: 1, failing: 1 });

      // Not yet, unless asked.
      gallery.readProblem.clear();
      gallery.reads.length = 0;
      await pass();
      expect(gallery.reads).toEqual([]);

      await sync.run({ retryNow: true });
      await sync.settled();
      expect(gallery.reads).toEqual([bad]);
      expect(sync.status()).toMatchObject({ done: 2, failing: 0 });
    });

    it('stops after several failures in a row rather than running through the whole gallery', async () => {
      for (let i = 0; i < 6; i++) {
        const id = gallery.add(makeJpeg({ color: `#${i}` }));
        gallery.readProblem.set(id, new GalleryReadError('failed', 'outage'));
      }
      const outcome = await pass();
      expect(outcome.phase).toBe('trouble');
      expect(outcome.resumeAt).toBeGreaterThan(Date.now());
      expect(gallery.reads).toHaveLength(3);
    });

    it('leaves a file Android lists but cannot find, without looping or counting it', async () => {
      const id = gallery.add(makeJpeg({ color: '#gone' }));
      gallery.readProblem.set(id, new GalleryReadError('gone', 'gone'));
      expect(await pass()).toMatchObject({ phase: 'idle' });
      expect(gallery.reads).toEqual([id]);
      expect(sync.status()).toMatchObject({ total: 0, failing: 0, remaining: 0 });
    });

    it('picks up a photo taken while it was busy, in the same pass', async () => {
      gallery.add(makeJpeg({ color: '#first' }));
      gallery.onRead = () => {
        gallery.onRead = null;
        gallery.add(makeJpeg({ color: '#during' }));
      };
      expect(await pass()).toMatchObject({ phase: 'idle', remaining: 0 });
      expect(stored()).toHaveLength(2);
      expect(gallery.outcomes).toHaveLength(1);
    });

    it('leaves a brand new file for a moment, in case it is still being written', async () => {
      gallery.add(makeJpeg({ color: '#fresh' }), 'fresh.jpg', Math.floor(Date.now() / 1000));
      const started = Date.now();
      await pass();
      expect(Date.now() - started).toBeGreaterThanOrEqual(8_000);
      expect(stored()).toHaveLength(1);
    }, 30_000);

    it('stops when asked, and the next pass finishes the job', async () => {
      gallery.add(makeJpeg({ color: '#1' }));
      gallery.add(makeJpeg({ color: '#2' }));
      gallery.onRead = () => sync.pause();
      await sync.run();
      await sync.settled();
      expect(gallery.last.phase).toBe('paused');
      gallery.onRead = null;
      expect(await pass()).toMatchObject({ phase: 'idle', remaining: 0 });
      expect(stored()).toHaveLength(2);
    });

  });

  describe('before it knows what Telegram holds', () => {
    const connectionLost = () => new Error('connection lost');
    const inTelegram = () => d.storage.storedCount(d.engine.store.account!.session!);

    /** A fresh install on the same phone, with `fault` in place from its first word with Telegram. */
    const reinstall = async (fault: () => void) => {
      ledger.close();
      ledgerName = `${ledgerName}-reinstalled`;
      await d.wipeBrowser();
      fault();
      await d.signIn();
      await start();
    };

    /** Reading the channel fails, after letting this many messages through. Returns how to undo it. */
    const failScan = (make: () => Error, after = 0) => {
      const storage = d.storage;
      const real = storage.scanLibrary.bind(storage);
      storage.scanLibrary = async function* (ctx, options) {
        let passed = 0;
        for await (const message of real(ctx, options)) {
          if (passed++ === after) throw make();
          yield message;
        }
        if (passed <= after) throw make();
      };
      return () => {
        storage.scanLibrary = real;
      };
    };

    it('sends nothing after a reinstall until it can read the channel, then finds it all already there', async () => {
      for (const color of ['#1', '#2', '#3']) gallery.add(makeJpeg({ color }));
      await pass();
      const sent = await inTelegram();
      const reads = gallery.reads.length;
      let restore!: () => void;
      await reinstall(() => {
        restore = failScan(connectionLost, 1);
      });

      const outcome = await pass();

      expect(outcome.phase).toBe('trouble');
      expect(outcome.resumeAt).toBeGreaterThan(Date.now());
      expect(gallery.reads).toHaveLength(reads);
      expect(await inTelegram()).toBe(sent);

      restore();
      expect(await pass()).toMatchObject({ phase: 'idle', remaining: 0 });
      expect(await inTelegram()).toBe(sent);
      expect(sync.status()).toMatchObject({ done: 3 });
    });

    it('carries on from where a failed scan stopped, rather than reading the channel again', async () => {
      for (const color of ['#1', '#2', '#3']) gallery.add(makeJpeg({ color }));
      await pass();
      let restore!: () => void;
      await reinstall(() => {
        restore = failScan(connectionLost, 1);
      });
      expect(d.engine.store.allPhotos()).toHaveLength(1);
      restore();

      const real = d.storage.scanLibrary.bind(d.storage);
      const startedAfter: (number | undefined)[] = [];
      d.storage.scanLibrary = (ctx, options) => {
        startedAfter.push(options?.afterMessageId);
        return real(ctx, options);
      };
      await pass();
      d.storage.scanLibrary = real;

      expect(startedAfter[0]).toBeGreaterThan(0);
      expect(stored()).toHaveLength(3);
    });

    it('does not send a photo deleted for good when the record of that cannot be read', async () => {
      const bytes = makeJpeg({ color: '#gone' });
      gallery.add(bytes);
      await pass();
      const row = stored()[0]!;
      await d.engine.setTrashed([row.id], true);
      await d.engine.deleteForever([row.id]);
      await d.engine.sync.flush();
      const sent = await inTelegram();
      const reads = gallery.reads.length;
      const real = d.storage.readState.bind(d.storage);
      await reinstall(() => {
        d.storage.readState = async () => {
          throw connectionLost();
        };
      });

      expect(await pass()).toMatchObject({ phase: 'trouble' });
      expect(gallery.reads).toHaveLength(reads);

      d.storage.readState = real;
      expect(await pass()).toMatchObject({ phase: 'idle' });
      expect(await inTelegram()).toBe(sent);
      expect(d.engine.store.getPhotoBySha(sha256(bytes))).toBeUndefined();
    });

    it('waits as long as Telegram asks if told to while reading the channel, and remembers that', async () => {
      gallery.add(makeJpeg({ color: '#w' }));
      const restore = failScan(() => new RateLimitedError(3600));
      await restartApp();

      const outcome = await pass();

      expect(outcome.phase).toBe('rate-limited');
      expect(outcome.resumeAt).toBeGreaterThan(Date.now() + 3000 * 1000);
      expect(gallery.reads).toEqual([]);

      restore();
      await restartApp();
      expect(await pass()).toMatchObject({ phase: 'rate-limited' });
      expect(gallery.reads).toEqual([]);
    });

    it('asks to sign in when reading the channel shows the session has ended', async () => {
      gallery.add(makeJpeg({ color: '#r' }));
      const restore = failScan(() => new SessionRevokedError('AUTH_KEY_UNREGISTERED'));
      await restartApp();

      expect(await pass()).toMatchObject({ phase: 'needs-sign-in' });
      expect(gallery.reads).toEqual([]);
      expect(d.engine.store.account?.needs_reauth).toBe(true);
      restore();
    });

    it('asks to sign in when reading the synced state shows the session has ended', async () => {
      gallery.add(makeJpeg({ color: '#r' }));
      const real = d.storage.readState.bind(d.storage);
      d.storage.readState = async () => {
        throw new SessionRevokedError('AUTH_KEY_UNREGISTERED');
      };
      await restartApp();

      expect(await pass()).toMatchObject({ phase: 'needs-sign-in' });
      expect(d.engine.store.account?.needs_reauth).toBe(true);
      d.storage.readState = real;
    });

    it('waits for a connection if that is why it failed, and still asks to be woken for it', async () => {
      gallery.add(makeJpeg({ color: '#o' }));
      const restore = failScan(connectionLost);
      gallery.networkNow = 'none';
      await restartApp();

      const outcome = await pass();

      expect(outcome.phase).toBe('waiting-network');
      // Nothing has been counted yet, so a time is the only thing that gets Android to look again.
      expect(outcome.remaining).toBe(0);
      expect(outcome.resumeAt).toBeGreaterThan(0);
      expect(gallery.reads).toEqual([]);
      restore();
    });

    it('stops when asked, even if reading the channel has got stuck', async () => {
      gallery.add(makeJpeg({ color: '#s' }));
      let unstick!: () => void;
      const stuck = new Promise<void>((resolve) => {
        unstick = resolve;
      });
      const real = d.storage.scanLibrary.bind(d.storage);
      d.storage.scanLibrary = async function* () {
        await stuck;
      };
      await restartApp();

      const running = sync.run();
      await vi.waitFor(() => expect(sync.status().phase).toBe('checking'));
      sync.pause();
      await running;

      expect(gallery.last.phase).toBe('paused');
      expect(gallery.reads).toEqual([]);

      unstick();
      d.storage.scanLibrary = real;
      await d.engine.whenCaughtUp();
    });
  });

  describe('signing out', () => {
    it('turns off, forgets the phone, and starts afresh for the next person', async () => {
      gallery.add(makeJpeg({ color: '#mine' }));
      await pass();
      await sync.signOut();
      await d.engine.signOut();
      expect(gallery.enabled).toBe(false);

      await d.signIn('+15550000009');
      gallery.enabled = true;
      gallery.reads.length = 0;
      await pass();

      expect(gallery.reads).toHaveLength(1);
      expect(stored()).toHaveLength(1);
    });
  });

  it('moves on as soon as each photo is stored, rather than waiting on a timer that a hidden page would slow down', async () => {
    for (let i = 0; i < 30; i++) gallery.add(makeJpeg({ color: `#speed${i}` }));
    const started = Date.now();
    expect(await pass()).toMatchObject({ phase: 'idle', remaining: 0 });
    // Polling once a second for each one would take at least 30 seconds.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(stored()).toHaveLength(30);
  }, 40_000);

  it('reports progress as it goes, so the notification can follow', async () => {
    gallery.add(makeJpeg({ color: '#1' }));
    gallery.add(makeJpeg({ color: '#2' }));
    await pass();
    expect(gallery.reports.some((r) => r.phase === 'backing-up')).toBe(true);
    expect(gallery.reports[gallery.reports.length - 1]).toMatchObject({ phase: 'idle', done: 2, total: 2, remaining: 0 });
    expect(gallery.outcomes).toHaveLength(1);
  });
});
