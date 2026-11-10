import type { StoredPiece } from './pieces';

export type PhotoStatus = 'queued' | 'uploading' | 'stored' | 'failed';
export type PreviewState = 'ready' | 'missing' | 'unavailable';

export interface CameraMeta {
  camera_make: string | null;
  camera_model: string | null;
  lens: string | null;
  iso: number | null;
  f_number: number | null;
  exposure_time: number | null;
  focal_length: number | null;
  gps_lat: number | null;
  gps_lon: number | null;
}

export interface PhotoRow extends CameraMeta {
  /** Only means something on this device. Between devices a photo is known by its sha256. */
  id: number;
  sha256: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  /** Wall-clock time where the photo was taken, with no zone: 2024-07-01T18:22:10. */
  taken_at: string;
  taken_source: 'exif' | 'file' | 'upload' | 'telegram';
  uploaded_at: number;
  status: PhotoStatus;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  /** The message holding the file, or its first piece, which is also the one with the thumbnail. */
  tg_message_id: number | null;
  /**
   * In order, for a file too large for one message. Filled in as each piece is confirmed, so an
   * upload that stops partway has these with `tg_message_id` still null. Null for everything else.
   */
  tg_parts: StoredPiece[] | null;
  preview_state: PreviewState;
  preview_attempts: number;
  favorite: boolean;
  trashed_at: number | null;
  /** When favorite, Trash or camera details last changed, which decides who wins between devices. */
  changed_at: number;
  /** Uploaded straight into an album, so it stays out of Photos for as long as an album holds it. */
  album_only: boolean;
}

export interface AlbumRow {
  id: number;
  /** Stable across devices, unlike `id`. */
  uuid: string;
  title: string;
  cover_sha: string | null;
  created_at: number;
  updated_at: number;
  /** sha256 to the time it was added. By hash, so an album can name a photo this device has not seen yet. */
  photos: Record<string, number>;
  /** Kept as a record once deleted, so the deletion reaches other devices. */
  deleted_at: number | null;
}

export interface AccountRow {
  tg_user_id: string;
  phone: string;
  first_name: string;
  last_name: string;
  username: string;
  session: string | null;
  channel_id: string | null;
  channel_access_hash: string | null;
  needs_reauth: boolean;
}

export type NewPhoto = Pick<
  PhotoRow,
  | 'sha256' | 'filename' | 'mime' | 'size' | 'width' | 'height' | 'taken_at' | 'taken_source'
  | 'camera_make' | 'camera_model' | 'lens' | 'iso' | 'f_number' | 'exposure_time' | 'focal_length'
  | 'gps_lat' | 'gps_lon' | 'status' | 'tg_message_id' | 'preview_state'
> & { changed_at?: number; album_only?: boolean; tg_parts?: StoredPiece[] | null };

export type PhotoView =
  | { kind: 'timeline' }
  | { kind: 'favorites' }
  | { kind: 'trash' }
  | { kind: 'album'; albumId: number };

export interface LibraryStats {
  count: number;
  bytes: number;
  trash: number;
  pending: number;
  failed: number;
}

const MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

const DB_VERSION = 1;
/** Enough to flick back through recent photos. Older ones are simply rebuilt if opened again. */
const MAX_CACHED_PREVIEWS = 300;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('meta');
      db.createObjectStore('photos', { keyPath: 'id' });
      db.createObjectStore('albums', { keyPath: 'id' });
      db.createObjectStore('thumbs');
      db.createObjectStore('previews', { keyPath: 'sha256' }).createIndex('at', 'at');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other Tele-Photo tabs, then reload this one.'));
  });
}

/**
 * The library index for this browser.
 *
 * Reads come from memory and every change is written through to IndexedDB, so a list of 50,000
 * photos filters instantly and still survives a reload. Nothing here is the only copy of anything:
 * photos live in Telegram, and albums and favorites are synced there too. If a browser clears
 * this, signing in again rebuilds it.
 */
export class Store {
  private photos = new Map<number, PhotoRow>();
  private bySha = new Map<string, PhotoRow>();
  private albums = new Map<number, AlbumRow>();
  private meta = new Map<string, unknown>();
  /** Told about anything another device needs to hear about. */
  onStateChange: (() => void) | null = null;

  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = 'tele-photo'): Promise<Store> {
    const store = new Store(await openDb(name));
    await store.load();
    return store;
  }

  private async load(): Promise<void> {
    const tx = this.db.transaction(['meta', 'photos', 'albums'], 'readonly');
    const [keys, values, photos, albums] = await Promise.all([
      request(tx.objectStore('meta').getAllKeys()),
      request(tx.objectStore('meta').getAll()),
      request(tx.objectStore('photos').getAll() as IDBRequest<PhotoRow[]>),
      request(tx.objectStore('albums').getAll() as IDBRequest<AlbumRow[]>),
    ]);
    keys.forEach((key, i) => this.meta.set(String(key), values[i]));
    for (const row of photos) {
      // Saved before album-only photos existed.
      row.album_only ??= false;
      // Saved before videos could be split.
      row.tg_parts ??= null;
      this.index(row);
    }
    for (const row of albums) this.albums.set(row.id, row);
  }

  close(): void {
    this.db.close();
  }

  /** Empties everything on this device. Used when signing out, so nothing lingers on a shared computer. */
  async wipe(): Promise<void> {
    const names = ['meta', 'photos', 'albums', 'thumbs', 'previews'];
    const tx = this.db.transaction(names, 'readwrite');
    for (const name of names) tx.objectStore(name).clear();
    await done(tx);
    this.photos.clear();
    this.bySha.clear();
    this.albums.clear();
    this.meta.clear();
  }

  private index(row: PhotoRow): void {
    this.photos.set(row.id, row);
    this.bySha.set(row.sha256, row);
  }

  private async writePhotos(rows: PhotoRow[]): Promise<void> {
    if (rows.length === 0) return;
    const tx = this.db.transaction('photos', 'readwrite');
    const os = tx.objectStore('photos');
    for (const row of rows) os.put(row);
    await done(tx);
  }

  private async writeAlbum(row: AlbumRow): Promise<void> {
    const tx = this.db.transaction('albums', 'readwrite');
    tx.objectStore('albums').put(row);
    await done(tx);
  }

  private nextId(key: 'nextPhotoId' | 'nextAlbumId'): { id: number; following: number } {
    const id = (this.meta.get(key) as number | undefined) ?? 1;
    this.meta.set(key, id + 1);
    return { id, following: id + 1 };
  }

  // ---- settings ------------------------------------------------------------------------------

  getMeta<T>(key: string): T | undefined {
    return this.meta.get(key) as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    this.meta.set(key, value);
    const tx = this.db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(value, key);
    await done(tx);
  }

  // ---- the account ---------------------------------------------------------------------------

  get account(): AccountRow | null {
    return this.getMeta<AccountRow>('account') ?? null;
  }

  async setAccount(account: AccountRow): Promise<void> {
    await this.setMeta('account', account);
  }

  async setNeedsReauth(): Promise<void> {
    const account = this.account;
    if (account && !account.needs_reauth) await this.setAccount({ ...account, needs_reauth: true });
  }

  // ---- photos --------------------------------------------------------------------------------

  async insertPhoto(photo: NewPhoto): Promise<number> {
    return (await this.insertPhotos([photo]))[0]!;
  }

  /** In one transaction, because a restore adds thousands of these. */
  async insertPhotos(photos: NewPhoto[]): Promise<number[]> {
    if (photos.length === 0) return [];
    const now = Date.now();
    const rows: PhotoRow[] = [];
    // Ids are never reused, so a cached thumbnail can never turn up under another photo.
    let next = (this.meta.get('nextPhotoId') as number | undefined) ?? 1;
    for (const photo of photos) {
      if (this.bySha.has(photo.sha256)) throw new Error('This photo is already in the library');
      const row: PhotoRow = {
        ...photo,
        id: next++,
        uploaded_at: now,
        attempts: 0,
        next_attempt_at: 0,
        last_error: null,
        preview_attempts: 0,
        favorite: false,
        trashed_at: null,
        changed_at: photo.changed_at ?? 0,
        album_only: photo.album_only ?? false,
        tg_parts: photo.tg_parts ?? null,
      };
      this.index(row);
      rows.push(row);
    }
    this.meta.set('nextPhotoId', next);
    const tx = this.db.transaction(['photos', 'meta'], 'readwrite');
    const os = tx.objectStore('photos');
    for (const row of rows) os.put(row);
    tx.objectStore('meta').put(next, 'nextPhotoId');
    await done(tx);
    return rows.map((r) => r.id);
  }

  getPhoto(id: number): PhotoRow | undefined {
    return this.photos.get(id);
  }

  getPhotoBySha(sha256: string): PhotoRow | undefined {
    return this.bySha.get(sha256);
  }

  getPhotos(ids: number[]): PhotoRow[] {
    return ids.map((id) => this.photos.get(id)).filter((p): p is PhotoRow => p !== undefined);
  }

  allPhotos(): PhotoRow[] {
    return [...this.photos.values()];
  }

  listPhotos(view: PhotoView, query: string): PhotoRow[] {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const album = view.kind === 'album' ? this.albums.get(view.albumId) : null;
    const held = view.kind === 'timeline' ? this.heldByAlbums() : null;

    const matchesToken = (photo: PhotoRow, token: string) => {
      const fields = [photo.filename, photo.camera_make, photo.camera_model, photo.lens, photo.taken_at];
      if (fields.some((field) => field?.toLowerCase().includes(token))) return true;
      const month = MONTHS[token];
      return month !== undefined && photo.taken_at.slice(5, 7) === month;
    };

    const rows: PhotoRow[] = [];
    for (const photo of this.photos.values()) {
      if (view.kind === 'trash' ? photo.trashed_at === null : photo.trashed_at !== null) continue;
      if (held && photo.album_only && held.has(photo.sha256)) continue;
      if (view.kind === 'favorites' && !photo.favorite) continue;
      if (view.kind === 'album' && !album?.photos[photo.sha256]) continue;
      if (tokens.every((token) => matchesToken(photo, token))) rows.push(photo);
    }
    return rows.sort((a, b) => (a.taken_at === b.taken_at ? b.id - a.id : a.taken_at < b.taken_at ? 1 : -1));
  }

  async setFavorite(ids: number[], favorite: boolean): Promise<void> {
    const now = Date.now();
    const rows = this.getPhotos(ids);
    for (const row of rows) Object.assign(row, { favorite, changed_at: now });
    await this.writePhotos(rows);
    this.onStateChange?.();
  }

  async setTrashed(ids: number[], trashedAt: number | null): Promise<void> {
    const now = Date.now();
    const rows = this.getPhotos(ids);
    for (const row of rows) Object.assign(row, { trashed_at: trashedAt, changed_at: now });
    await this.writePhotos(rows);
    this.onStateChange?.();
  }

  /** Takes what other devices decided, without treating it as new local changes. In one transaction, as a new device gets thousands. */
  async applyRemote(changes: { row: PhotoRow; change: Partial<PhotoRow> }[]): Promise<void> {
    for (const { row, change } of changes) Object.assign(row, change);
    await this.writePhotos(changes.map((c) => c.row));
  }

  async deletePhotoRows(ids: number[]): Promise<void> {
    const rows = this.getPhotos(ids);
    if (rows.length === 0) return;
    const tx = this.db.transaction(['photos', 'thumbs', 'previews'], 'readwrite');
    for (const row of rows) {
      tx.objectStore('photos').delete(row.id);
      tx.objectStore('thumbs').delete(row.sha256);
      tx.objectStore('previews').delete(row.sha256);
    }
    await done(tx);
    for (const row of rows) {
      this.photos.delete(row.id);
      this.bySha.delete(row.sha256);
    }
  }

  trashedBefore(cutoff: number): PhotoRow[] {
    // A photo still uploading has no Telegram message yet, so it waits until the job settles.
    return this.allPhotos().filter((p) => p.trashed_at !== null && p.trashed_at <= cutoff && p.status !== 'uploading');
  }

  trashedIds(): number[] {
    return this.allPhotos().filter((p) => p.trashed_at !== null).map((p) => p.id);
  }

  libraryStats(): LibraryStats {
    const stats: LibraryStats = { count: 0, bytes: 0, trash: 0, pending: 0, failed: 0 };
    for (const p of this.photos.values()) {
      if (p.trashed_at === null) stats.count++;
      else stats.trash++;
      if (p.status === 'stored') stats.bytes += p.size;
      if (p.status === 'queued' || p.status === 'uploading') stats.pending++;
      if (p.status === 'failed') stats.failed++;
    }
    return stats;
  }

  // ---- upload queue --------------------------------------------------------------------------

  nextUploadJob(now: number, hasFile: (id: number) => boolean): PhotoRow | undefined {
    if (!this.account?.session || this.account.needs_reauth || !this.account.channel_id) return undefined;
    let best: PhotoRow | undefined;
    for (const p of this.photos.values()) {
      if (p.status !== 'queued' || p.next_attempt_at > now || !hasFile(p.id)) continue;
      if (!best || p.next_attempt_at < best.next_attempt_at || (p.next_attempt_at === best.next_attempt_at && p.id < best.id)) best = p;
    }
    return best;
  }

  private async patchPhoto(id: number, change: Partial<PhotoRow>): Promise<void> {
    const row = this.photos.get(id);
    if (!row) return;
    Object.assign(row, change);
    await this.writePhotos([row]);
  }

  markUploading(id: number): Promise<void> {
    return this.patchPhoto(id, { status: 'uploading', last_error: null });
  }

  markStored(id: number, messageId: number): Promise<void> {
    return this.patchPhoto(id, { status: 'stored', tg_message_id: messageId, last_error: null });
  }

  /** Getting a piece through shows the connection is working, so earlier failures stop counting against it. */
  savePieces(id: number, pieces: StoredPiece[]): Promise<void> {
    return this.patchPhoto(id, { tg_parts: pieces, attempts: 0 });
  }

  /** Puts a job back in line. `countAttempt` is false when the wait was not this photo's fault. */
  rescheduleUpload(id: number, nextAttemptAt: number, error: string | null, countAttempt: boolean): Promise<void> {
    const attempts = (this.photos.get(id)?.attempts ?? 0) + (countAttempt ? 1 : 0);
    return this.patchPhoto(id, { status: 'queued', next_attempt_at: nextAttemptAt, last_error: error, attempts });
  }

  markFailed(id: number, error: string): Promise<void> {
    const attempts = (this.photos.get(id)?.attempts ?? 0) + 1;
    return this.patchPhoto(id, { status: 'failed', last_error: error, attempts });
  }

  async retryFailed(ids: number[] | null, hasFile: (id: number) => boolean): Promise<number> {
    const rows = (ids ? this.getPhotos(ids) : this.allPhotos()).filter((p) => p.status === 'failed' && hasFile(p.id));
    for (const row of rows) Object.assign(row, { status: 'queued', attempts: 0, next_attempt_at: 0, last_error: null });
    await this.writePhotos(rows);
    return rows.length;
  }

  uploadActivity(): PhotoRow[] {
    const rank = (p: PhotoRow) => (p.status === 'uploading' ? 0 : 1);
    return this.allPhotos()
      .filter((p) => p.status !== 'stored')
      .sort((a, b) => rank(a) - rank(b) || a.id - b.id)
      .slice(0, 200);
  }

  /**
   * After a reload the browser no longer holds the files that were waiting, so these cannot finish
   * on their own. The photos themselves are safe, as the originals are still on the person's device.
   */
  async failInterrupted(message: string, hasFile: (id: number) => boolean): Promise<void> {
    const rows = this.allPhotos().filter((p) => (p.status === 'queued' || p.status === 'uploading') && !hasFile(p.id));
    for (const row of rows) Object.assign(row, { status: 'failed', last_error: message });
    await this.writePhotos(rows);
  }

  // ---- restoring thumbnails ------------------------------------------------------------------

  nextPreviewJob(): PhotoRow | undefined {
    if (!this.account?.session || this.account.needs_reauth) return undefined;
    let best: PhotoRow | undefined;
    for (const p of this.photos.values()) {
      if (p.preview_state !== 'missing' || p.status !== 'stored' || p.trashed_at !== null) continue;
      if (!best || p.taken_at > best.taken_at) best = p;
    }
    return best;
  }

  async markPreviewResult(id: number, state: PreviewState, meta: Partial<CameraMeta & { width: number | null; height: number | null }> = {}): Promise<void> {
    const row = this.photos.get(id);
    if (!row) return;
    const known = Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== null && value !== undefined));
    const learned = Object.keys(known).some((key) => key !== 'width' && key !== 'height' && row[key as keyof PhotoRow] !== known[key]);
    await this.patchPhoto(id, { preview_state: state, ...known, ...(learned ? { changed_at: Date.now() } : {}) });
    if (learned) this.onStateChange?.();
  }

  async bumpPreviewAttempt(id: number): Promise<number> {
    const attempts = (this.photos.get(id)?.preview_attempts ?? 0) + 1;
    await this.patchPhoto(id, { preview_attempts: attempts });
    return attempts;
  }

  // ---- albums --------------------------------------------------------------------------------

  /**
   * Every photo some album holds. An album-only photo that nothing holds is shown in Photos, so
   * that however it came about, such as an album deleted on another device, a photo in Telegram
   * always has somewhere to be seen.
   */
  private heldByAlbums(): Set<string> {
    const held = new Set<string>();
    for (const album of this.albums.values()) {
      if (album.deleted_at !== null) continue;
      for (const sha of Object.keys(album.photos)) held.add(sha);
    }
    return held;
  }

  listAlbums(): (AlbumRow & { photo_count: number; cover_id: number | null; only_here_count: number })[] {
    const holders = new Map<string, number>();
    for (const album of this.albums.values()) {
      if (album.deleted_at !== null) continue;
      for (const sha of Object.keys(album.photos)) holders.set(sha, (holders.get(sha) ?? 0) + 1);
    }
    return [...this.albums.values()]
      .filter((a) => a.deleted_at === null)
      .sort((a, b) => b.updated_at - a.updated_at || b.id - a.id)
      .map((album) => {
        const visible = Object.keys(album.photos)
          .map((sha) => this.bySha.get(sha))
          .filter((p): p is PhotoRow => p !== undefined && p.trashed_at === null);
        const chosen = album.cover_sha ? visible.find((p) => p.sha256 === album.cover_sha) : undefined;
        const newest = visible.reduce<PhotoRow | undefined>((best, p) => (!best || p.taken_at > best.taken_at ? p : best), undefined);
        const onlyHere = visible.filter((p) => p.album_only && holders.get(p.sha256) === 1);
        return { ...album, photo_count: visible.length, cover_id: (chosen ?? newest)?.id ?? null, only_here_count: onlyHere.length };
      });
  }

  getAlbum(id: number): AlbumRow | undefined {
    const album = this.albums.get(id);
    return album && album.deleted_at === null ? album : undefined;
  }

  /** Includes deleted ones, because a deletion still has to be passed on to other devices. */
  allAlbums(): AlbumRow[] {
    return [...this.albums.values()];
  }

  albumsForPhoto(sha256: string): AlbumRow[] {
    return [...this.albums.values()].filter((a) => a.deleted_at === null && a.photos[sha256]);
  }

  async createAlbum(title: string): Promise<number> {
    const { id, following } = this.nextId('nextAlbumId');
    const now = Date.now();
    const row: AlbumRow = { id, uuid: crypto.randomUUID(), title, cover_sha: null, created_at: now, updated_at: now, photos: {}, deleted_at: null };
    this.albums.set(id, row);
    const tx = this.db.transaction(['albums', 'meta'], 'readwrite');
    tx.objectStore('albums').put(row);
    tx.objectStore('meta').put(following, 'nextAlbumId');
    await done(tx);
    this.onStateChange?.();
    return id;
  }

  private async changeAlbum(id: number, change: (album: AlbumRow) => void): Promise<void> {
    const album = this.getAlbum(id);
    if (!album) return;
    change(album);
    album.updated_at = Date.now();
    await this.writeAlbum(album);
    this.onStateChange?.();
  }

  updateAlbum(id: number, patch: { title?: string; coverSha?: string | null }): Promise<void> {
    return this.changeAlbum(id, (album) => {
      if (patch.title !== undefined) album.title = patch.title;
      if (patch.coverSha !== undefined) album.cover_sha = patch.coverSha;
    });
  }

  deleteAlbum(id: number): Promise<void> {
    return this.changeAlbum(id, (album) => {
      album.deleted_at = Date.now();
      album.photos = {};
    });
  }

  addToAlbum(id: number, photoIds: number[]): Promise<void> {
    const now = Date.now();
    return this.changeAlbum(id, (album) => {
      for (const photo of this.getPhotos(photoIds)) album.photos[photo.sha256] ??= now;
    });
  }

  removeFromAlbum(id: number, photoIds: number[]): Promise<void> {
    return this.changeAlbum(id, (album) => {
      for (const photo of this.getPhotos(photoIds)) delete album.photos[photo.sha256];
    });
  }

  /** Album-only photos that would have no album left if this one went away. Trashed ones count. */
  photosOnlyIn(id: number): PhotoRow[] {
    const album = this.getAlbum(id);
    if (!album) return [];
    const others = new Set<string>();
    for (const other of this.albums.values()) {
      if (other.id === id || other.deleted_at !== null) continue;
      for (const sha of Object.keys(other.photos)) others.add(sha);
    }
    return Object.keys(album.photos)
      .map((sha) => this.bySha.get(sha))
      .filter((p): p is PhotoRow => p !== undefined && p.album_only && !others.has(p.sha256));
  }

  async setAlbumOnly(ids: number[], albumOnly: boolean): Promise<void> {
    const now = Date.now();
    const rows = this.getPhotos(ids);
    for (const row of rows) Object.assign(row, { album_only: albumOnly, changed_at: now });
    await this.writePhotos(rows);
    this.onStateChange?.();
  }

  /** Makes ordinary library photos of any of these that no album holds any more. Returns how many. */
  async releaseAlbumOnly(ids: number[]): Promise<number> {
    const held = this.heldByAlbums();
    const rows = this.getPhotos(ids).filter((p) => p.album_only && !held.has(p.sha256));
    if (rows.length > 0) await this.setAlbumOnly(rows.map((p) => p.id), false);
    return rows.length;
  }

  /** For photos whose album is going away. Once restored they have no album to return to, so they count as library photos. */
  async trashAlbumOnly(ids: number[]): Promise<void> {
    const now = Date.now();
    const rows = this.getPhotos(ids);
    for (const row of rows) Object.assign(row, { album_only: false, trashed_at: row.trashed_at ?? now, changed_at: now });
    await this.writePhotos(rows);
    this.onStateChange?.();
  }

  /** Takes another device's version of an album, or creates it if this device has not seen it. */
  async applyRemoteAlbum(uuid: string, remote: Omit<AlbumRow, 'id' | 'uuid'>): Promise<void> {
    const existing = [...this.albums.values()].find((a) => a.uuid === uuid);
    if (existing) {
      Object.assign(existing, remote);
      await this.writeAlbum(existing);
      return;
    }
    const { id, following } = this.nextId('nextAlbumId');
    const row: AlbumRow = { ...remote, id, uuid };
    this.albums.set(id, row);
    const tx = this.db.transaction(['albums', 'meta'], 'readwrite');
    tx.objectStore('albums').put(row);
    tx.objectStore('meta').put(following, 'nextAlbumId');
    await done(tx);
  }

  // ---- cached images -------------------------------------------------------------------------

  async getThumb(sha256: string): Promise<Blob | null> {
    const tx = this.db.transaction('thumbs', 'readonly');
    return (await request(tx.objectStore('thumbs').get(sha256) as IDBRequest<Blob | undefined>)) ?? null;
  }

  async getPreview(sha256: string): Promise<Blob | null> {
    const tx = this.db.transaction('previews', 'readonly');
    const row = await request(tx.objectStore('previews').get(sha256) as IDBRequest<{ blob: Blob } | undefined>);
    return row?.blob ?? null;
  }

  /** Best effort. A full disk means images get fetched again next time, which is not worth failing over. */
  async cacheThumb(sha256: string, blob: Blob): Promise<void> {
    try {
      const tx = this.db.transaction('thumbs', 'readwrite');
      tx.objectStore('thumbs').put(blob, sha256);
      await done(tx);
    } catch {
      // See above.
    }
  }

  async cachePreview(sha256: string, blob: Blob): Promise<void> {
    try {
      const tx = this.db.transaction('previews', 'readwrite');
      const os = tx.objectStore('previews');
      os.put({ sha256, blob, at: Date.now() });
      const count = await request(os.count());
      if (count > MAX_CACHED_PREVIEWS) {
        let excess = count - MAX_CACHED_PREVIEWS;
        const cursor = os.index('at').openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c || excess <= 0) return;
          excess--;
          c.delete();
          c.continue();
        };
      }
      await done(tx);
    } catch {
      // See cacheThumb.
    }
  }
}
