import { cleanFilename, parseCaption, type PartFacts } from './caption';
import { piecesOf, type StoredPiece, wholeName } from './pieces';
import type { NewPhoto, PhotoRow, Store } from './store';
import type { UploadQueue } from './queue';
import type { StateSync } from './sync';
import { type ScannedPhoto, SessionRevokedError, type StorageBackend, type StorageContext } from './types';

const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCAN_BATCH = 200;

/** Pieces seen so far of a file not yet complete, by index. */
interface PartialFile {
  count: number;
  pieces: Record<number, StoredPiece & { filename: string; hasThumb: boolean }>;
}

const PARTIAL_FILES_KEY = 'partialFiles';

export interface ScanState {
  running: boolean;
  scanned: number;
  added: number;
  error: string | null;
}

export interface LibraryDeps {
  store: Store;
  storage: StorageBackend;
  queue: UploadQueue;
  sync: StateSync;
  context: () => StorageContext;
  onRevoked: () => void;
  retentionDays: number;
}

export class Library {
  private scan: ScanState = { running: false, scanned: 0, added: 0, error: null };
  private currentScan: Promise<void> | null = null;
  private failure: unknown = null;
  private purgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: LibraryDeps) {}

  /**
   * There is no server running at 3 a.m. to do this, so it happens whenever this code is running:
   * with the app open, or on Android during a background backup. A photo may outstay its 30 days
   * if neither happens, but it is never deleted early.
   */
  startPurgeTimer(): void {
    void this.purgeExpired();
    this.purgeTimer ??= setInterval(() => void this.purgeExpired(), PURGE_INTERVAL_MS);
  }

  stop(): void {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.purgeTimer = null;
  }

  /**
   * Permanently removes photos, from Telegram first and then locally. If Telegram refuses, the
   * local record stays, so the photo can never end up in Telegram with nothing pointing at it.
   * A photo mid-upload is skipped, because its message does not exist yet.
   */
  async deletePermanently(photos: PhotoRow[]): Promise<{ deleted: number; skipped: number }> {
    const { store, storage, sync, queue, context } = this.deps;
    const removable = photos.filter((p) => p.status !== 'uploading');
    const messageIds = removable.flatMap((p) => piecesOf(p).map((piece) => piece.messageId));
    if (messageIds.length > 0) await storage.deletePhotos(context(), messageIds);

    // Checked again now that the await is over: the queue may have picked up a photo meanwhile.
    const fresh = store.getPhotos(removable.map((p) => p.id)).filter((p) => p.status !== 'uploading');
    // Saved before the rows go, so nothing can bring these back if the page ends right after.
    await sync.recordDeleted(fresh.map((p) => p.sha256));
    await store.deletePhotoRows(fresh.map((p) => p.id));
    for (const photo of fresh) queue.detach(photo.id);
    return { deleted: fresh.length, skipped: photos.length - fresh.length };
  }

  async purgeExpired(now = Date.now()): Promise<number> {
    const { store } = this.deps;
    if (!store.account?.session || store.account.needs_reauth) return 0;
    const photos = store.trashedBefore(now - this.deps.retentionDays * DAY_MS);
    if (photos.length === 0) return 0;
    try {
      return (await this.deletePermanently(photos)).deleted;
    } catch {
      // Offline or signed out. Those photos stay in Trash and the next pass tries again.
      return 0;
    }
  }

  scanState(): ScanState {
    return this.scan;
  }

  /** What stopped the last scan, if anything did, as it was thrown. */
  get scanFailure(): unknown {
    return this.failure;
  }

  /** Reads the Telegram channel and adds anything this device does not know about. */
  startScan(options: { full: boolean }): ScanState {
    if (!this.scan.running) {
      this.scan = { running: true, scanned: 0, added: 0, error: null };
      this.failure = null;
      this.currentScan = this.runScan(this.scan, options.full).finally(() => {
        this.currentScan = null;
      });
    }
    return this.scan;
  }

  /** Waits for whatever scan is running. */
  async settled(): Promise<void> {
    await this.currentScan;
  }

  /**
   * Notes one piece of a split file, and returns all of them once they are all here. Kept between
   * scans, because a scan only reads what is new since the last one, and the pieces of a video
   * being uploaded on another device arrive over many scans.
   */
  private async gatherPiece(sha256: string, part: PartFacts, item: ScannedPhoto) {
    const { store } = this.deps;
    const partial = { ...store.getMeta<Record<string, PartialFile>>(PARTIAL_FILES_KEY) };
    const file: PartialFile = partial[sha256]?.count === part.count ? partial[sha256] : { count: part.count, pieces: {} };
    file.pieces[part.index] = { messageId: item.messageId, size: item.size, filename: item.filename, hasThumb: item.hasThumb };
    partial[sha256] = file;

    const pieces = Object.keys(file.pieces).map(Number).sort((a, b) => a - b).map((index) => file.pieces[index]!);
    const complete = pieces.length === part.count && pieces.reduce((sum, p) => sum + p.size, 0) === part.totalSize;
    if (complete) delete partial[sha256];
    await store.setMeta(PARTIAL_FILES_KEY, partial);
    return complete ? pieces : null;
  }

  private async runScan(state: ScanState, full: boolean): Promise<void> {
    const { store, storage, queue, sync, context } = this.deps;
    let batch: NewPhoto[] = [];
    let newest = store.getMeta<number>('lastScannedMessageId') ?? 0;
    const seen = new Set<string>();

    const flush = async () => {
      const ids = await store.insertPhotos(batch);
      state.added += ids.length;
      batch = [];
      // The channel is read oldest first, so all of it up to here is dealt with. A scan that fails
      // later carries on from this point, which is what lets a poor connection ever finish one.
      await store.setMeta('lastScannedMessageId', newest);
    };

    try {
      const ctx: StorageContext = context();
      const after = full ? 0 : newest;
      for await (const item of storage.scanLibrary(ctx, { afterMessageId: after })) {
        newest = Math.max(newest, item.messageId);
        const facts = parseCaption(item.caption);
        if (!facts) continue; // Something the user posted by hand, or the synced state. Not a photo of ours.
        state.scanned++;
        if (store.getPhotoBySha(facts.sha256) || seen.has(facts.sha256) || sync.isDeleted(facts.sha256)) continue;
        const whole = facts.part ? await this.gatherPiece(facts.sha256, facts.part, item) : null;
        // Another device may still be uploading the rest, so this waits, however long that takes.
        if (facts.part && !whole) continue;
        seen.add(facts.sha256);
        batch.push({
          sha256: facts.sha256,
          // A channel can be posted to by hand, so a name from one is treated like any other input.
          filename: cleanFilename(whole ? wholeName(whole[0]!.filename) : item.filename),
          mime: facts.part?.mime ?? item.mime,
          size: facts.part?.totalSize ?? item.size,
          width: facts.width,
          height: facts.height,
          taken_at: facts.takenAt,
          taken_source: 'telegram',
          camera_make: null, camera_model: null, lens: null, iso: null, f_number: null,
          exposure_time: null, focal_length: null, gps_lat: null, gps_lon: null,
          status: 'stored',
          tg_message_id: whole ? whole[0]!.messageId : item.messageId,
          tg_parts: whole ? whole.map(({ messageId, size }) => ({ messageId, size })) : null,
          // Telegram usually has a thumbnail, so nothing needs downloading. If not, one gets built.
          preview_state: (whole ? whole[0]!.hasThumb : item.hasThumb) ? 'ready' : 'missing',
          // Known straight away, so a rebuild never shows these in Photos while it is still running.
          album_only: sync.isAlbumOnly(facts.sha256),
        });
        if (batch.length >= SCAN_BATCH) await flush();
      }
      await flush();
      await sync.apply();
    } catch (err) {
      await flush().catch(() => undefined);
      if (err instanceof SessionRevokedError) this.deps.onRevoked();
      this.failure = err;
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.running = false;
      queue.notify();
    }
  }
}
