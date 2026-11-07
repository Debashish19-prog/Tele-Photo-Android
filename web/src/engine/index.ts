import { cleanFilename } from './caption';
import { Library, type ScanState } from './library';
import { browserMedia, hashBlob, mediaLimiter, type MediaTools } from './media';
import { collectBlob, INTERRUPTED_MESSAGE, PREVIEW_DOWNLOAD_LIMIT, UploadQueue } from './queue';
import { StateSync } from './sync';
import { type AccountRow, type LibraryStats, type PhotoRow, type PhotoView, Store } from './store';
import {
  type CodeResult,
  type LoginSuccess,
  RateLimitedError,
  SessionRevokedError,
  type StorageBackend,
  type StorageContext,
  UserFacingError,
} from './types';

export { UserFacingError } from './types';
export type { LibraryStats, ScanState };

/**
 * The most a non-Premium account can upload as a single file: 4000 parts of 512 KiB.
 * This is 2,097,152,000 bytes (about 1.95 GiB). Anything larger fails on Telegram's side
 * with FILE_PARTS_INVALID, so we refuse it before doing any work.
 */
export const MAX_PHOTO_BYTES = 4000 * 512 * 1024;
const MAX_ZIP_PHOTOS = 2000;
const DEFAULT_TRASH_RETENTION_DAYS = 30;
/** Originals kept in memory after being viewed, so zooming in does not download one twice. */
const RECENT_ORIGINALS = 3;
const RECENT_ORIGINAL_MAX_BYTES = 60 * 1024 * 1024;

export interface Account {
  id: number;
  firstName: string;
  lastName: string;
  username: string;
  phone: string;
  needsReauth: boolean;
}

export interface Session {
  storage: 'telegram' | 'fake';
  configured: boolean;
  account: Account | null;
}

export interface PhotoItem {
  id: number;
  width: number;
  height: number;
  takenAt: string;
  filename: string;
  favorite: boolean;
  pending: boolean;
  failed: boolean;
  noPreview: boolean;
  previewComing: boolean;
}

export interface PhotoDetail {
  id: number;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  takenAt: string;
  takenSource: 'exif' | 'file' | 'upload' | 'telegram';
  uploadedAt: number;
  sha256: string;
  camera: { make: string | null; model: string | null; lens: string | null; iso: number | null; fNumber: number | null; exposureTime: number | null; focalLength: number | null };
  location: { lat: number; lon: number } | null;
  status: 'queued' | 'uploading' | 'stored' | 'failed';
  error: string | null;
  telegramMessageId: number | null;
  previewState: 'ready' | 'missing' | 'unavailable';
  favorite: boolean;
  trashedAt: number | null;
  purgeAt: number | null;
  albums: { id: number; title: string }[];
  /** True when this photo is kept out of Photos, and is only reachable through its albums. */
  albumOnly: boolean;
}

export interface Album {
  id: number;
  title: string;
  photoCount: number;
  coverId: number | null;
  updatedAt: number;
  /** Photos uploaded straight into this album that no other album holds, so they go if it goes. */
  onlyHereCount: number;
}

export interface QueueItem {
  id: number;
  filename: string;
  size: number;
  status: 'queued' | 'uploading' | 'failed';
  progress: number | null;
  error: string | null;
  nextAttemptAt: number | null;
  /** A reloaded tab needs the person to select the original again before retrying. */
  needsFile: boolean;
}

export interface UploadStatus {
  items: QueueItem[];
  stats: LibraryStats;
  scan: ScanState;
  /** Goes up when another device changes something, so the screen knows to refresh. */
  revision: number;
}

export type PhotoQuery = { view?: 'favorites' | 'trash'; album?: number; q?: string };

export interface IngestResult {
  id: number;
  duplicate: boolean;
  restored: boolean;
  /** Set when an automatic backup left this alone, because the person had already removed it. */
  skipped?: 'trashed' | 'deleted';
}

export interface IngestOptions {
  /** Uploads into this album only, keeping the photo out of Photos. */
  albumId?: number;
  /** Reattaches selected originals without importing new photos or changing their albums. */
  retryOnly?: boolean;
  /**
   * The app found this file by itself, rather than the person choosing it. So it must not undo
   * anything they did: a photo they trashed or deleted stays that way, and albums are left alone.
   */
  autoSync?: boolean;
  /** Stores the file with a placeholder tile, for a photo too large to decode without crashing. */
  skipPreviews?: boolean;
}

export interface EngineOptions {
  storage: StorageBackend;
  configured: boolean;
  media?: MediaTools;
  dbName?: string;
  trashRetentionDays?: number;
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[\s().-]/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

function nowAsWallClock(): string {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 19);
}

function albumTitle(raw: string): string {
  const title = raw.trim();
  if (!title) throw new UserFacingError('BAD_REQUEST', 'Give the album a name.');
  return title.slice(0, 200);
}

function toItem(p: PhotoRow): PhotoItem {
  return {
    id: p.id,
    width: p.width ?? 4,
    height: p.height ?? 3,
    takenAt: p.taken_at,
    filename: p.filename,
    favorite: p.favorite,
    pending: p.status === 'queued' || p.status === 'uploading',
    failed: p.status === 'failed',
    noPreview: p.preview_state === 'unavailable',
    previewComing: p.preview_state === 'missing',
  };
}

/**
 * Everything the server used to do, running in this browser tab.
 *
 * It talks straight to Telegram, with no server between the two. The session lives only on this
 * device, and photos go from here to Telegram over an encrypted socket, so whoever hosts the site
 * never sees either. All the site has to provide is the code itself, which any static host can do.
 */
export class Engine {
  readonly store: Store;
  readonly storage: StorageBackend;
  readonly queue: UploadQueue;
  readonly library: Library;
  readonly sync: StateSync;
  private readonly media: MediaTools;
  private readonly configured: boolean;
  private readonly retentionDays: number;
  private revision = 0;
  private running = false;
  private catching: Promise<void> = Promise.resolve();
  /** What stopped the last catch-up, if anything did. */
  private catchUpFailure: unknown = null;
  private readonly originals = new Map<number, Blob>();
  private readonly originalLoads = new Map<number, Promise<Blob>>();

  private constructor(store: Store, options: EngineOptions) {
    this.store = store;
    this.storage = options.storage;
    this.media = options.media ?? browserMedia;
    this.configured = options.configured;
    this.retentionDays = options.trashRetentionDays ?? DEFAULT_TRASH_RETENTION_DAYS;
    const context = () => this.context();
    const onRevoked = () => void store.setNeedsReauth();
    this.queue = new UploadQueue({ store, storage: this.storage, media: this.media, context, onRevoked });
    this.sync = new StateSync({
      store,
      storage: this.storage,
      context,
      onRevoked,
      onPhotosRemoved: (ids) => {
        for (const id of ids) this.queue.detach(id);
      },
      onRemoteChange: () => {
        this.revision++;
      },
    });
    this.library = new Library({ store, storage: this.storage, queue: this.queue, sync: this.sync, context, onRevoked, retentionDays: this.retentionDays });
    store.onStateChange = () => this.sync.markDirty();
  }

  static async open(options: EngineOptions): Promise<Engine> {
    const engine = new Engine(await Store.open(options.dbName), options);
    if (engine.store.account?.session) await engine.startBackground();
    return engine;
  }

  /** Stops everything this tab is doing, without changing any saved data. */
  async close(): Promise<void> {
    this.stopBackground();
    await this.storage.close().catch(() => undefined);
    this.store.close();
  }

  private stopBackground(): void {
    this.running = false;
    this.queue.stop();
    this.library.stop();
    this.sync.stop();
  }

  private async startBackground(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.sync.start();
    await this.queue.start();
    this.catching = this.catchUp();
    this.library.startPurgeTimer();
  }

  /** Resolves when everything in the background has finished. For tests and tooling. */
  async whenIdle(): Promise<void> {
    await this.catching;
    await this.library.settled();
    await this.queue.drain();
  }

  /**
   * Resolves once this device knows what Telegram already holds, without waiting for uploads.
   * Rejects if it could not find out. An earlier failure is tried again first, as nothing else will.
   */
  async whenCaughtUp(): Promise<void> {
    if (this.catchUpFailure) this.catching = this.catchUp();
    // Coming back into view can start another one meanwhile, and that one has to finish as well.
    for (let waited: Promise<void> | null = null; waited !== this.catching; ) {
      waited = this.catching;
      await waited;
    }
    await this.library.settled();
    if (this.catchUpFailure) throw this.catchUpFailure;
  }

  /** Brings this device up to date with what other devices have done. */
  private async catchUp(): Promise<void> {
    this.catchUpFailure = null;
    let failure: unknown = null;
    await this.sync.pull().catch((err: unknown) => {
      failure = err;
      if (err instanceof SessionRevokedError) void this.store.setNeedsReauth();
    });
    this.library.startScan({ full: false });
    await this.library.settled();
    this.catchUpFailure = failure ?? this.library.scanFailure;
    this.queue.notify();
  }

  /** Called when the app comes back into view. */
  refresh(): void {
    if (this.running && !this.store.account?.needs_reauth && this.sync.isStale) this.catching = this.catchUp();
  }

  private context(): StorageContext {
    const account = this.store.account;
    if (!account?.session || !account.channel_id || !account.channel_access_hash) throw new SessionRevokedError('NO_SESSION');
    return { session: account.session, library: { channelId: account.channel_id, accessHash: account.channel_access_hash } };
  }

  private requireAccount(): AccountRow {
    const account = this.store.account;
    if (!account) throw new UserFacingError('NOT_SIGNED_IN', 'Please sign in.', 401);
    return account;
  }

  /** Turns the conditions that are nobody's fault into messages a person can act on. */
  private async explained<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof SessionRevokedError) {
        await this.store.setNeedsReauth();
        throw new UserFacingError('REAUTH', 'Telegram ended this session. Please sign in again.', 401);
      }
      if (err instanceof RateLimitedError) {
        throw new UserFacingError('RATE_LIMITED', `Telegram asked us to wait ${err.seconds} seconds. Try again shortly.`, 503);
      }
      throw err;
    }
  }

  // ---- signing in ----------------------------------------------------------------------------

  session(): Session {
    const account = this.store.account;
    return {
      storage: this.storage.kind,
      configured: this.configured,
      account:
        account && (account.session || account.needs_reauth)
          ? {
              id: Number(account.tg_user_id),
              firstName: account.first_name,
              lastName: account.last_name,
              username: account.username,
              phone: account.phone,
              needsReauth: account.needs_reauth,
            }
          : null,
    };
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new UserFacingError('NOT_CONFIGURED', 'This site was built without VITE_TELEGRAM_API_ID and VITE_TELEGRAM_API_HASH.', 503);
    }
  }

  sendCode(rawPhone: string) {
    this.assertConfigured();
    const phone = normalizePhone(rawPhone);
    if (!/^\+[0-9]{6,16}$/.test(phone)) {
      throw new UserFacingError('PHONE_INVALID', 'Include the country code, like +1 555 123 4567.');
    }
    return this.storage.sendLoginCode(phone);
  }

  async submitCode(loginId: string, code: string): Promise<{ status: 'ok' } | { status: 'password'; hint: string }> {
    const result: CodeResult = await this.storage.submitLoginCode(loginId, code.trim());
    if (result.status === 'needs-password') return { status: 'password', hint: result.hint };
    return this.completeLogin(result);
  }

  async submitPassword(loginId: string, password: string): Promise<{ status: 'ok' }> {
    return this.completeLogin(await this.storage.submitLoginPassword(loginId, password));
  }

  private async completeLogin(success: LoginSuccess): Promise<{ status: 'ok' }> {
    const { store, storage } = this;
    let previous = store.account;

    // Someone else's account on this browser: nothing of the last person's may carry over.
    if (previous && previous.tg_user_id !== success.user.id) {
      this.stopBackground();
      await store.wipe();
      previous = null;
    }

    const account: AccountRow = {
      tg_user_id: success.user.id,
      phone: success.user.phone,
      first_name: success.user.firstName,
      last_name: success.user.lastName,
      username: success.user.username,
      session: success.session,
      channel_id: previous?.channel_id ?? null,
      channel_access_hash: previous?.channel_access_hash ?? null,
      needs_reauth: false,
    };
    if (!account.channel_id) {
      const { library } = await storage.ensureLibrary(success.session);
      account.channel_id = library.channelId;
      account.channel_access_hash = library.accessHash;
    }
    await store.setAccount(account);

    // One live Telegram session per browser. Signing in again replaces the old one.
    if (previous?.session && previous.session !== success.session) {
      void storage.revokeSession(previous.session).catch(() => undefined);
    }

    // A browser may evict this data under disk pressure unless asked not to. It can all be rebuilt, so a refusal is fine.
    void navigator.storage?.persist?.().catch(() => undefined);
    await this.startBackground();
    this.queue.notify();
    return { status: 'ok' };
  }

  /**
   * Ends the Telegram session and clears this browser. There is no milder version of this, because
   * no server holds a copy of the session: leaving it active would just strand it in the person's
   * list of devices. Their photos and albums are safe in Telegram and come back at the next sign-in.
   */
  async signOut(): Promise<void> {
    const session = this.store.account?.session ?? null;
    await this.sync.flush().catch(() => false);
    this.stopBackground();
    if (session) await this.storage.revokeSession(session).catch(() => undefined);
    await this.store.wipe();
    this.originals.clear();
  }

  // ---- the library ---------------------------------------------------------------------------

  private owned(id: number): PhotoRow {
    this.requireAccount();
    const photo = this.store.getPhoto(id);
    if (!photo) throw new UserFacingError('NOT_FOUND', 'Not found.', 404);
    return photo;
  }

  photos(query: PhotoQuery): PhotoItem[] {
    this.requireAccount();
    let view: PhotoView = { kind: 'timeline' };
    if (query.view === 'favorites') view = { kind: 'favorites' };
    if (query.view === 'trash') view = { kind: 'trash' };
    if (query.album) {
      if (!this.store.getAlbum(query.album)) throw new UserFacingError('NOT_FOUND', 'Album not found.', 404);
      view = { kind: 'album', albumId: query.album };
    }
    return this.store.listPhotos(view, query.q ?? '').map(toItem);
  }

  photo(id: number): PhotoDetail {
    const p = this.owned(id);
    const albums = this.store.albumsForPhoto(p.sha256).map((a) => ({ id: a.id, title: a.title }));
    return {
      id: p.id,
      filename: p.filename,
      mime: p.mime,
      size: p.size,
      width: p.width,
      height: p.height,
      takenAt: p.taken_at,
      takenSource: p.taken_source,
      uploadedAt: p.uploaded_at,
      sha256: p.sha256,
      camera: { make: p.camera_make, model: p.camera_model, lens: p.lens, iso: p.iso, fNumber: p.f_number, exposureTime: p.exposure_time, focalLength: p.focal_length },
      location: p.gps_lat !== null && p.gps_lon !== null ? { lat: p.gps_lat, lon: p.gps_lon } : null,
      status: p.status,
      error: p.last_error,
      telegramMessageId: p.tg_message_id,
      previewState: p.preview_state,
      favorite: p.favorite,
      trashedAt: p.trashed_at,
      purgeAt: p.trashed_at ? p.trashed_at + this.retentionDays * 24 * 60 * 60 * 1000 : null,
      albums,
      albumOnly: p.album_only && albums.length > 0,
    };
  }

  async setFavorite(ids: number[], favorite: boolean): Promise<void> {
    this.requireAccount();
    await this.store.setFavorite(ids, favorite);
  }

  async setTrashed(ids: number[], trashed: boolean): Promise<void> {
    this.requireAccount();
    await this.store.setTrashed(ids, trashed ? Date.now() : null);
  }

  /** Permanent. Only accepts photos already in the Trash, so nothing is one click from gone. */
  deleteForever(ids: number[]) {
    this.requireAccount();
    const photos = this.store.getPhotos(ids).filter((p) => p.trashed_at !== null);
    return this.explained(() => this.library.deletePermanently(photos));
  }

  emptyTrash() {
    this.requireAccount();
    return this.explained(() => this.library.deletePermanently(this.store.getPhotos(this.store.trashedIds())));
  }

  libraryInfo() {
    this.requireAccount();
    return { stats: this.store.libraryStats(), trashRetentionDays: this.retentionDays };
  }

  rescan(): ScanState {
    this.requireAccount();
    return this.library.startScan({ full: true });
  }

  // ---- albums --------------------------------------------------------------------------------

  private albumShape(a: ReturnType<Store['listAlbums']>[number]): Album {
    return { id: a.id, title: a.title, photoCount: a.photo_count, coverId: a.cover_id, updatedAt: a.updated_at, onlyHereCount: a.only_here_count };
  }

  albums(): Album[] {
    this.requireAccount();
    return this.store.listAlbums().map((a) => this.albumShape(a));
  }

  album(id: number): Album {
    this.requireAccount();
    const listed = this.store.listAlbums().find((a) => a.id === id);
    if (!listed) throw new UserFacingError('NOT_FOUND', 'Album not found.', 404);
    return this.albumShape(listed);
  }

  async createAlbum(title: string, photoIds: number[] = []): Promise<{ id: number }> {
    this.requireAccount();
    const id = await this.store.createAlbum(albumTitle(title));
    if (photoIds.length > 0) await this.addToAlbum(id, photoIds);
    return { id };
  }

  async updateAlbum(id: number, patch: { title?: string; coverPhotoId?: number | null }): Promise<void> {
    this.album(id);
    if (patch.title !== undefined) await this.store.updateAlbum(id, { title: albumTitle(patch.title) });
    if (patch.coverPhotoId !== undefined) {
      const coverSha = patch.coverPhotoId === null ? null : this.owned(patch.coverPhotoId).sha256;
      await this.store.updateAlbum(id, { coverSha });
    }
  }

  /**
   * Photos that came from the library stay there. Those uploaded only to this album have nowhere
   * else to go, so they move to Trash, where they can still be rescued. Trash comes first, so that
   * being interrupted here can never leave them in Photos.
   */
  async deleteAlbum(id: number): Promise<{ movedToTrash: number }> {
    this.album(id);
    const orphans = this.store.photosOnlyIn(id);
    const movedToTrash = orphans.filter((p) => p.trashed_at === null).length;
    await this.store.trashAlbumOnly(orphans.map((p) => p.id));
    await this.store.deleteAlbum(id);
    return { movedToTrash };
  }

  async addToAlbum(id: number, ids: number[]): Promise<void> {
    this.album(id);
    // Anything being shown in Photos was picked from there, so adding it must not make it vanish.
    await this.store.releaseAlbumOnly(ids);
    await this.store.addToAlbum(id, ids);
  }

  /** A photo leaving its last album moves to Photos, rather than being left with nowhere to be seen. */
  async removeFromAlbum(id: number, ids: number[]): Promise<{ movedToPhotos: number }> {
    this.album(id);
    await this.store.removeFromAlbum(id, ids);
    return { movedToPhotos: await this.store.releaseAlbumOnly(ids) };
  }

  // ---- uploads -------------------------------------------------------------------------------

  /**
   * Takes in one file: checks it really is an image, recognises it if it has been seen before,
   * makes its thumbnails, and queues it for Telegram. The file's bytes are never modified.
   */
  async ingest(file: Blob, rawName: string, lastModified: string | null, onProgress: (fraction: number) => void = () => undefined, options: IngestOptions = {}): Promise<IngestResult> {
    this.requireAccount();
    const { store, queue, media } = this;
    // Asked each time, as the album may be deleted while a large file is being read. The photo then goes to Photos.
    const targetAlbum = () => (options.albumId !== undefined && store.getAlbum(options.albumId) ? options.albumId : null);

    if (file.size === 0) throw new UserFacingError('EMPTY_FILE', 'This file is empty.');
    if (file.size > MAX_PHOTO_BYTES) throw new UserFacingError('TOO_LARGE', 'This file is larger than the 1.95 GB Telegram accepts in a single upload.', 413);

    const type = await media.sniffImage(file);
    if (!type) throw new UserFacingError('NOT_A_PHOTO', 'Only photos can be stored right now, and this file is not a recognised image format.', 415);

    const sha256 = await hashBlob(file, onProgress);
    const known = store.getPhotoBySha(sha256);
    const previews = () => (options.skipPreviews ? Promise.resolve(null) : mediaLimiter(() => media.makePreviews(file, type.mime)));
    if (known) {
      if (options.autoSync && known.trashed_at !== null) return { id: known.id, duplicate: true, restored: false, skipped: 'trashed' };
      // A failed upload is still an upload, even if this tab already holds its file.
      if (known.status !== 'stored' && (!queue.hasFile(known.id) || known.status === 'failed')) {
        const shown = await previews();
        queue.attach(known.id, file, shown?.telegramThumb ?? null);
        if (known.status === 'failed') await store.retryFailed([known.id], queue.hasFile);
        else await store.rescheduleUpload(known.id, 0, null, false);
        // Finishing an interrupted upload, so it stays wherever it was first sent, even if added again from elsewhere.
        const album = options.retryOnly ? null : targetAlbum();
        if (album !== null) await store.addToAlbum(album, [known.id]);
        queue.notify();
        return { id: known.id, duplicate: false, restored: false };
      }
      if (options.retryOnly || options.autoSync) return { id: known.id, duplicate: known.status === 'stored', restored: false };
      return this.placeKnown(known, targetAlbum());
    }
    if (options.autoSync && this.sync.isDeleted(sha256)) return { id: 0, duplicate: true, restored: false, skipped: 'deleted' };
    if (options.retryOnly) throw new UserFacingError('NOT_AN_UPLOAD', 'This file does not match an existing upload. Select the original photo again.');

    const fileDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(lastModified ?? '') ? lastModified : null;
    const [meta, shown] = await Promise.all([media.readMetadata(file), previews()]);

    // The same bytes may have arrived twice at once, in which case the other one has won by now.
    const winner = store.getPhotoBySha(sha256);
    if (winner && options.autoSync) return { id: winner.id, duplicate: winner.status === 'stored', restored: false };
    if (winner) return this.placeKnown(winner, targetAlbum());

    const album = targetAlbum();
    const hasCamera = [meta.camera_make, meta.camera_model, meta.lens, meta.iso, meta.f_number, meta.exposure_time, meta.focal_length, meta.gps_lat, meta.gps_lon].some((v) => v !== null);
    const id = await store.insertPhoto({
      sha256,
      filename: cleanFilename(rawName),
      mime: type.mime,
      size: file.size,
      width: shown?.width ?? meta.exifWidth,
      height: shown?.height ?? meta.exifHeight,
      taken_at: meta.takenAt ?? fileDate ?? nowAsWallClock(),
      taken_source: meta.takenAt ? 'exif' : fileDate ? 'file' : 'upload',
      camera_make: meta.camera_make,
      camera_model: meta.camera_model,
      lens: meta.lens,
      iso: meta.iso,
      f_number: meta.f_number,
      exposure_time: meta.exposure_time,
      focal_length: meta.focal_length,
      gps_lat: meta.gps_lat,
      gps_lon: meta.gps_lon,
      status: 'queued',
      tg_message_id: null,
      preview_state: shown ? 'ready' : 'unavailable',
      changed_at: hasCamera || album !== null ? Date.now() : 0,
      album_only: album !== null,
    });
    if (shown) {
      await store.cacheThumb(sha256, shown.thumb);
      await store.cachePreview(sha256, shown.preview);
    }
    queue.attach(id, file, shown?.telegramThumb ?? null);
    if (album !== null) await store.addToAlbum(album, [id]);
    if (hasCamera) this.sync.markDirty();
    queue.notify();
    return { id, duplicate: false, restored: false };
  }

  /** The same bytes again. Nothing new goes to Telegram, but where the person put them still counts. */
  private async placeKnown(known: PhotoRow, album: number | null): Promise<IngestResult> {
    const { store } = this;
    // Uploading something that is in the Trash means the person wants it back.
    const restored = known.trashed_at !== null;
    if (restored) await store.setTrashed([known.id], null);
    if (album !== null) {
      await store.addToAlbum(album, [known.id]);
      // It had left the library, so it comes back to the one place it was just put.
      if (restored && !known.album_only) await store.setAlbumOnly([known.id], true);
    } else if (known.album_only) {
      // Uploaded to Photos on purpose, so it belongs there now, as well as in its albums.
      await store.setAlbumOnly([known.id], false);
    }
    return { id: known.id, duplicate: true, restored };
  }

  uploadStatus(): UploadStatus {
    this.requireAccount();
    const items = this.store.uploadActivity().map((p): QueueItem => ({
      id: p.id,
      filename: p.filename,
      size: p.size,
      status: p.status as QueueItem['status'],
      progress: this.queue.progress.get(p.id) ?? (p.status === 'uploading' ? 0 : null),
      error: p.last_error,
      nextAttemptAt: p.next_attempt_at > Date.now() ? p.next_attempt_at : null,
      needsFile: !this.queue.hasFile(p.id),
    }));
    return { items, stats: this.store.libraryStats(), scan: this.library.scanState(), revision: this.revision };
  }

  async retryUploads(ids?: number[]): Promise<{ retried: number }> {
    this.requireAccount();
    const retried = await this.store.retryFailed(ids ?? null, this.queue.hasFile);
    this.queue.notify();
    const stuck = (ids ? this.store.getPhotos(ids) : this.store.allPhotos()).some((p) => p.status === 'failed' && !this.queue.hasFile(p.id));
    if (stuck) throw new UserFacingError('FILE_NEEDED', INTERRUPTED_MESSAGE);
    return { retried };
  }

  /** Gives up on a photo that has not reached Telegram. */
  async cancelUpload(id: number): Promise<void> {
    const photo = this.owned(id);
    if (photo.status === 'stored') throw new UserFacingError('ALREADY_STORED', 'This photo is already stored. Move it to Trash instead.', 409);
    if (photo.status === 'uploading') throw new UserFacingError('BUSY', 'This photo is being sent right now.', 409);
    await this.library.deletePermanently([photo]);
  }

  get hasUploadsInProgress(): boolean {
    return this.queue.hasWork;
  }

  // ---- images --------------------------------------------------------------------------------

  /** The grid's image. Null means there is nothing to show, not that something went wrong. */
  async thumb(id: number): Promise<Blob | null> {
    const photo = this.owned(id);
    const cached = await this.store.getThumb(photo.sha256);
    if (cached) return cached;
    if (photo.status !== 'stored' || photo.tg_message_id === null || photo.preview_state !== 'ready') return null;
    const blob = await this.explained(() => this.storage.getThumb(this.context(), photo.tg_message_id!));
    if (blob) {
      await this.store.cacheThumb(photo.sha256, blob);
      return blob;
    }
    // Telegram has no thumbnail for this one, so the queue will build one from the original.
    await this.store.markPreviewResult(id, 'missing');
    this.queue.notify();
    return null;
  }

  /**
   * The viewer's image. If this device does not have one yet, the original has to be downloaded to
   * make it. Null means that is more than should happen without being asked, unless `force` is set.
   */
  async preview(id: number, options: { force?: boolean } = {}): Promise<Blob | null> {
    const photo = this.owned(id);
    const cached = await this.store.getPreview(photo.sha256);
    if (cached) return cached;
    if (photo.preview_state === 'unavailable') return null;
    if (!options.force && photo.size > PREVIEW_DOWNLOAD_LIMIT && !this.queue.hasFile(id)) return null;

    const original = await this.original(id);
    const shown = await mediaLimiter(() => this.media.makePreviews(original, photo.mime));
    if (!shown) {
      await this.store.markPreviewResult(id, 'unavailable');
      return null;
    }
    await this.store.cachePreview(photo.sha256, shown.preview);
    if (!(await this.store.getThumb(photo.sha256))) await this.store.cacheThumb(photo.sha256, shown.thumb);

    // Opening a restored photo is the first chance to learn its camera details on this device.
    const { takenAt: _takenAt, exifWidth: _w, exifHeight: _h, ...camera } = await this.media.readMetadata(original);
    await this.store.markPreviewResult(id, 'ready', { ...camera, width: shown.width, height: shown.height });
    return shown.preview;
  }

  /** Comes from this device until Telegram has it, and from Telegram from then on. */
  original(id: number): Promise<Blob> {
    const photo = this.owned(id);
    const local = this.queue.fileFor(id);
    if (local) return Promise.resolve(local);

    const recent = this.originals.get(id);
    if (recent) return Promise.resolve(recent);
    const loading = this.originalLoads.get(id);
    if (loading) return loading;
    if (photo.tg_message_id === null) throw new UserFacingError('FILE_NEEDED', INTERRUPTED_MESSAGE);

    const load = this.explained(async () => {
      const { stream } = await this.storage.getPhoto(this.context(), photo.tg_message_id!);
      const blob = await collectBlob(stream, photo.mime);
      if (blob.size <= RECENT_ORIGINAL_MAX_BYTES) {
        this.originals.set(id, blob);
        while (this.originals.size > RECENT_ORIGINALS) this.originals.delete(this.originals.keys().next().value!);
      }
      return blob;
    }).finally(() => this.originalLoads.delete(id));
    this.originalLoads.set(id, load);
    return load;
  }

  /** Streams an original straight through without holding on to it, for large downloads. */
  async openOriginalStream(id: number): Promise<AsyncIterable<Uint8Array>> {
    const photo = this.owned(id);
    const local = this.queue.fileFor(id);
    if (local) {
      return (async function* () {
        for (let at = 0; at < local.size; at += 512 * 1024) yield new Uint8Array(await local.slice(at, at + 512 * 1024).arrayBuffer());
      })();
    }
    if (photo.tg_message_id === null) throw new UserFacingError('FILE_NEEDED', INTERRUPTED_MESSAGE);
    return this.explained(async () => (await this.storage.getPhoto(this.context(), photo.tg_message_id!)).stream);
  }

  photosForDownload(ids: number[]): PhotoRow[] {
    if (ids.length > MAX_ZIP_PHOTOS) throw new UserFacingError('BAD_REQUEST', 'You can download up to 2,000 photos at a time.');
    const photos = this.store.getPhotos(ids);
    if (photos.length === 0) throw new UserFacingError('NOT_FOUND', 'Not found.', 404);
    return photos;
  }
}
