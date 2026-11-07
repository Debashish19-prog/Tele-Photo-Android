import type { AlbumRow, CameraMeta, PhotoRow, Store } from './store';
import { RateLimitedError, SessionRevokedError, type StateVersion, type StorageBackend, type StorageContext } from './types';

const DOC_VERSION = 1;
/** Soon after a change, so another device opened now sees it. */
const SAVE_DELAY_MS = 5000;
/** A long upload changes this constantly, and there is no reason to send it every few seconds. */
const MIN_SAVE_GAP_MS = 30_000;
const RETRY_DELAY_MS = 60_000;
const REFRESH_GAP_MS = 60_000;

const CAMERA_FIELDS = ['camera_make', 'camera_model', 'lens', 'iso', 'f_number', 'exposure_time', 'focal_length', 'gps_lat', 'gps_lon'] as const;

/** Keyed by sha256 in the file, because a photo's local id means nothing on another device. */
interface PhotoRecord {
  /** When this last changed, which decides who wins. */
  u: number;
  /** Favorite. */
  f?: 1;
  /** Moved to Trash at. */
  t?: number;
  /** Deleted for good. */
  d?: 1;
  /** Camera details. Not stored in captions, and searched on, so they are carried here. */
  m?: Partial<CameraMeta>;
  /** Uploaded straight into an album, so it stays out of Photos. */
  o?: 1;
}

interface AlbumRecord {
  t: string;
  c: string | null;
  a: number;
  u: number;
  p: Record<string, number>;
  x: number | null;
}

export interface StateDoc {
  v: number;
  photos: Record<string, PhotoRecord>;
  albums: Record<string, AlbumRecord>;
}

const emptyDoc = (): StateDoc => ({ v: DOC_VERSION, photos: {}, albums: {} });

export async function encodeDoc(doc: StateDoc): Promise<Uint8Array> {
  const stream = new Blob([JSON.stringify(doc)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Returns null for anything unreadable, because a damaged file must never take the app down with it. */
export async function decodeDoc(bytes: Uint8Array): Promise<StateDoc | null> {
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    const doc = JSON.parse(await new Response(stream).text()) as StateDoc;
    return doc.v === DOC_VERSION && doc.photos && doc.albums ? doc : null;
  } catch {
    return null;
  }
}

function photoRecord(row: PhotoRow): PhotoRecord {
  const m: Partial<CameraMeta> = {};
  for (const field of CAMERA_FIELDS) {
    const value = row[field];
    if (value !== null) (m as Record<string, unknown>)[field] = value;
  }
  return {
    u: row.changed_at,
    ...(row.favorite ? { f: 1 as const } : {}),
    ...(row.trashed_at !== null ? { t: row.trashed_at } : {}),
    ...(row.album_only ? { o: 1 as const } : {}),
    ...(Object.keys(m).length > 0 ? { m } : {}),
  };
}

function albumRecord(album: AlbumRow): AlbumRecord {
  return { t: album.title, c: album.cover_sha, a: album.created_at, u: album.updated_at, p: album.photos, x: album.deleted_at };
}

export interface SyncDeps {
  store: Store;
  storage: StorageBackend;
  context: () => StorageContext;
  onRevoked: () => void;
  /** A photo another device deleted for good has gone from this one too. */
  onPhotosRemoved: (ids: number[]) => void;
  /** Something changed that the screen should show. */
  onRemoteChange: () => void;
}

/**
 * Keeps albums, favorites and Trash in step between devices, with Telegram as the meeting point.
 *
 * They live in one small file in the library channel. A device merges rather than overwrites: each
 * photo and album keeps whichever version changed last. If two devices save at the same moment and
 * one is overwritten, its own copy still holds the change, sees it is missing, and saves it again.
 */
export class StateSync {
  private doc: StateDoc = emptyDoc();
  private known: StateVersion | null = null;
  private dirty = false;
  /** Counts changes, to tell whether one arrived while a save was on its way to Telegram. */
  private changes = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSave = 0;
  private lastPull = 0;
  private stopped = true;

  constructor(private readonly deps: SyncDeps) {}

  start(): void {
    const { store } = this.deps;
    this.doc = store.getMeta<StateDoc>('syncDoc') ?? emptyDoc();
    this.known = store.getMeta<StateVersion>('syncKnown') ?? null;
    this.dirty = store.getMeta<boolean>('syncDirty') ?? false;
    this.stopped = false;
    if (this.dirty) this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  markDirty(): void {
    this.changes++;
    if (!this.dirty) {
      this.dirty = true;
      void this.deps.store.setMeta('syncDirty', true);
    }
    this.schedule();
  }

  private schedule(delay = Math.max(SAVE_DELAY_MS, this.lastSave + MIN_SAVE_GAP_MS - Date.now())): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save().catch(() => undefined);
    }, delay);
  }

  /**
   * Remembers a permanent delete, so other devices drop the photo too and nothing brings it back.
   * It is on this device's disk by the time this returns, because the photo's own row is about to
   * go and the page could end at any moment. Reaching Telegram can then wait for the next save.
   */
  async recordDeleted(sha256s: string[]): Promise<void> {
    if (sha256s.length === 0) return;
    const now = Date.now();
    for (const sha of sha256s) this.doc.photos[sha] = { u: now, d: 1 };
    this.markDirty();
    await this.deps.store.setMeta('syncDoc', this.doc);
  }

  isDeleted(sha256: string): boolean {
    return this.doc.photos[sha256]?.d === 1;
  }

  isAlbumOnly(sha256: string): boolean {
    return this.doc.photos[sha256]?.o === 1;
  }

  private merge(remote: StateDoc): void {
    for (const [sha, record] of Object.entries(remote.photos)) {
      const current = this.doc.photos[sha];
      if (!current || record.u > current.u) this.doc.photos[sha] = record;
    }
    for (const [uuid, record] of Object.entries(remote.albums)) {
      const current = this.doc.albums[uuid];
      if (!current || record.u > current.u) this.doc.albums[uuid] = record;
    }
  }

  /** Copies anything newer on this device into the file. */
  private absorbLocal(): void {
    const { store } = this.deps;
    for (const row of store.allPhotos()) {
      if (row.changed_at > (this.doc.photos[row.sha256]?.u ?? 0)) this.doc.photos[row.sha256] = photoRecord(row);
    }
    for (const album of store.allAlbums()) {
      const current = this.doc.albums[album.uuid];
      if (!current || album.updated_at > current.u) this.doc.albums[album.uuid] = albumRecord(album);
    }
  }

  /** Copies anything newer in the file onto this device. */
  async apply(): Promise<void> {
    const { store } = this.deps;
    const changes: Parameters<Store['applyRemote']>[0] = [];
    const removed: number[] = [];
    for (const [sha, record] of Object.entries(this.doc.photos)) {
      const row = store.getPhotoBySha(sha);
      if (!row || record.u <= row.changed_at) continue;
      if (record.d) {
        // A file being sent from this device right now outranks an old deletion, so it stays.
        if (row.status === 'stored') removed.push(row.id);
        continue;
      }
      const camera = Object.fromEntries(CAMERA_FIELDS.map((field) => [field, record.m?.[field] ?? row[field]]));
      changes.push({ row, change: { favorite: record.f === 1, trashed_at: record.t ?? null, album_only: record.o === 1, changed_at: record.u, ...camera } });
    }
    await store.applyRemote(changes);
    if (removed.length > 0) {
      await store.deletePhotoRows(removed);
      this.deps.onPhotosRemoved(removed);
    }

    let albumsChanged = false;
    for (const [uuid, record] of Object.entries(this.doc.albums)) {
      const local = store.allAlbums().find((a) => a.uuid === uuid);
      if (local && record.u <= local.updated_at) continue;
      await store.applyRemoteAlbum(uuid, { title: record.t, cover_sha: record.c, created_at: record.a, updated_at: record.u, photos: record.p, deleted_at: record.x });
      albumsChanged = true;
    }
    if (changes.length > 0 || removed.length > 0 || albumsChanged) this.deps.onRemoteChange();
  }

  /** True when the saved file is missing something this device knows, including after being overwritten. */
  private isAhead(remote: StateDoc | null): boolean {
    const photos = Object.entries(this.doc.photos);
    const albums = Object.entries(this.doc.albums);
    if (!remote) return photos.length > 0 || albums.length > 0;
    return photos.some(([sha, r]) => (remote.photos[sha]?.u ?? 0) < r.u) || albums.some(([uuid, r]) => (remote.albums[uuid]?.u ?? 0) < r.u);
  }

  private async pullNow(): Promise<void> {
    const { store, storage, context } = this.deps;
    const result = await storage.readState(context(), this.known);
    this.lastPull = Date.now();
    this.absorbLocal();
    if (result.changed) {
      let remote: StateDoc | null = null;
      if (result.file) {
        remote = await decodeDoc(result.file.bytes);
        if (remote) this.merge(remote);
        this.known = { messageId: result.file.messageId, version: result.file.version };
      } else {
        this.known = null;
      }
      if (this.isAhead(remote)) this.markDirty();
    }
    await this.apply();
    await store.setMeta('syncDoc', this.doc);
    await store.setMeta('syncKnown', this.known);
  }

  pull(): Promise<void> {
    return this.serial(() => this.pullNow());
  }

  /** Reads before writing, so saving can never throw away what another device just did. */
  save(): Promise<void> {
    return this.serial(async () => {
      if (!this.dirty || this.stopped) return;
      const { store, storage, context } = this.deps;
      try {
        await this.pullNow();
        const changes = this.changes;
        this.known = await storage.writeState(context(), await encodeDoc(this.doc), this.known);
        this.lastSave = Date.now();
        await store.setMeta('syncDoc', this.doc);
        await store.setMeta('syncKnown', this.known);
        if (this.changes === changes) {
          this.dirty = false;
          await store.setMeta('syncDirty', false);
        } else {
          // That arrived too late to be in the file just sent, so it still needs saving.
          this.schedule();
        }
      } catch (err) {
        if (err instanceof SessionRevokedError) {
          this.deps.onRevoked();
          return;
        }
        this.schedule(err instanceof RateLimitedError ? (err.seconds + 1) * 1000 : RETRY_DELAY_MS);
        throw err;
      }
    });
  }

  /** Last chance before signing out. Telegram being unreachable should not stop anyone signing out. */
  async flush(): Promise<boolean> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.absorbLocal();
    if (!this.dirty) return true;
    return this.save().then(() => !this.dirty, () => false);
  }

  /** For when the app comes back into view: another device may have been busy meanwhile. */
  get isStale(): boolean {
    return Date.now() - this.lastPull > REFRESH_GAP_MS;
  }

  get hasUnsavedChanges(): boolean {
    return this.dirty;
  }
}
