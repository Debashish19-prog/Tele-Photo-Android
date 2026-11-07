import { buildCaption } from './caption';
import { mediaLimiter, type MediaTools } from './media';
import type { PhotoRow, Store } from './store';
import { RateLimitedError, SessionRevokedError, type StorageBackend, type StorageContext } from './types';

const MAX_ATTEMPTS = 6;
const POLL_MS = 5000;
const MAX_PREVIEW_ATTEMPTS = 3;
/** Rebuilding a thumbnail means downloading the original, which is not worth it past this size. */
export const PREVIEW_DOWNLOAD_LIMIT = 50 * 1024 * 1024;
/** Held on to in pieces, as a Blob can spill to disk while plain arrays have to fit in memory. */
const COLLECT_ROLLUP_BYTES = 32 * 1024 * 1024;

const inAndroidApp = 'TelePhotoAndroid' in globalThis;

export const INTERRUPTED_MESSAGE = inAndroidApp
  ? 'The app closed before this reached Telegram. Auto backup finishes it if it is in your gallery. Otherwise, add the file again.'
  : 'The tab closed before this reached Telegram. Add the file again to finish.';
export const NO_FILE_MESSAGE = inAndroidApp
  ? 'The app no longer has this file. Auto backup finishes it if it is in your gallery. Otherwise, add the file again.'
  : 'This browser no longer has the file. Add it again to finish.';

/** Gathers a download into one Blob, without keeping all of it in plain memory on the way. */
export async function collectBlob(stream: AsyncIterable<Uint8Array>, type: string): Promise<Blob> {
  const finished: Blob[] = [];
  let open: BlobPart[] = [];
  let openBytes = 0;
  for await (const chunk of stream) {
    open.push(chunk as BlobPart);
    openBytes += chunk.byteLength;
    if (openBytes >= COLLECT_ROLLUP_BYTES) {
      finished.push(new Blob(open));
      open = [];
      openBytes = 0;
    }
  }
  return new Blob([...finished, ...open], { type });
}

export interface QueueDeps {
  store: Store;
  storage: StorageBackend;
  media: MediaTools;
  context: () => StorageContext;
  onRevoked: () => void;
}

/**
 * Moves originals from the person's device into Telegram, one at a time.
 *
 * Its progress is saved, but the files themselves are only references the browser gave this tab.
 * So unlike a queue on a server, it cannot carry on after the tab closes: anything unfinished is
 * marked as such, and adding the same file again picks it back up.
 */
export class UploadQueue {
  readonly progress = new Map<number, number>();
  private readonly files = new Map<number, { file: Blob; thumb: Blob | null }>();
  private busy = false;
  private pausedUntil = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private previewRunning = false;
  private readonly running = new Set<Promise<void>>();
  private changed: Promise<void> | null = null;
  private signalChanged: (() => void) | null = null;

  constructor(private readonly deps: QueueDeps) {}

  /**
   * Resolves when a job next ends. A phone slows timers right down on a page nobody can see, but
   * not the network, so waiting on this keeps a backup at full speed with the screen off.
   */
  whenChanged(): Promise<void> {
    return (this.changed ??= new Promise((resolve) => {
      this.signalChanged = resolve;
    }));
  }

  attach(id: number, file: Blob, thumb: Blob | null): void {
    this.files.set(id, { file, thumb });
  }

  detach(id: number): void {
    this.files.delete(id);
  }

  hasFile = (id: number): boolean => this.files.has(id);

  fileFor(id: number): Blob | null {
    return this.files.get(id)?.file ?? null;
  }

  /** True while closing the tab would leave a file behind. */
  get hasWork(): boolean {
    return this.files.size > 0 && this.deps.store.allPhotos().some((p) => this.files.has(p.id) && p.status !== 'failed' && p.status !== 'stored');
  }

  async start(): Promise<void> {
    await this.deps.store.failInterrupted(INTERRUPTED_MESSAGE, this.hasFile);
    this.stopped = false;
    this.timer ??= setInterval(() => this.notify(), POLL_MS);
    this.notify();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves when no job is running and none is ready to start. For tests and tooling. */
  async drain(): Promise<void> {
    for (;;) {
      this.notify();
      if (this.running.size === 0) return;
      await Promise.all(this.running);
    }
  }

  notify(): void {
    if (this.stopped) return;
    if (!this.busy && Date.now() >= this.pausedUntil) {
      const job = this.deps.store.nextUploadJob(Date.now(), this.hasFile);
      if (job) {
        this.busy = true;
        this.track(this.runUpload(job));
        return;
      }
    }
    if (!this.busy && !this.previewRunning && Date.now() >= this.pausedUntil) {
      const job = this.deps.store.nextPreviewJob();
      if (job) {
        this.previewRunning = true;
        this.track(this.runPreview(job));
      }
    }
  }

  private track(task: Promise<void>): void {
    this.running.add(task);
    void task
      .catch(() => undefined)
      .finally(() => {
        this.running.delete(task);
        this.notify();
        this.signalChanged?.();
        this.changed = null;
        this.signalChanged = null;
      });
  }

  private async runUpload(job: PhotoRow): Promise<void> {
    const { store, storage } = this.deps;
    const held = this.files.get(job.id);
    this.progress.set(job.id, 0);
    try {
      if (!held) {
        await store.markFailed(job.id, NO_FILE_MESSAGE);
        return;
      }
      await store.markUploading(job.id);
      const { messageId } = await storage.putPhoto(
        this.deps.context(),
        {
          file: held.file,
          thumb: held.thumb,
          filename: job.filename,
          mime: job.mime,
          size: job.size,
          caption: buildCaption({
            filename: job.filename, sha256: job.sha256, takenAt: job.taken_at, width: job.width, height: job.height,
          }),
        },
        (fraction) => this.progress.set(job.id, fraction),
      );
      // Saved first, let go of second. A failure in between leaves a spare reference, never a lost photo.
      await store.markStored(job.id, messageId);
      this.files.delete(job.id);
    } catch (err) {
      await this.handleUploadError(job, err);
    } finally {
      this.progress.delete(job.id);
      this.busy = false;
    }
  }

  private async handleUploadError(job: PhotoRow, err: unknown): Promise<void> {
    const { store } = this.deps;
    // Signing out closes the connection under the job, which is not the photo's fault.
    if (this.stopped) return;
    if (err instanceof SessionRevokedError) {
      this.deps.onRevoked();
      await store.rescheduleUpload(job.id, 0, null, false);
      return;
    }
    if (err instanceof RateLimitedError) {
      const resumeAt = Date.now() + (err.seconds + 1) * 1000;
      this.pausedUntil = resumeAt;
      await store.rescheduleUpload(job.id, resumeAt, null, false);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const attempts = store.getPhoto(job.id)?.attempts ?? job.attempts;
    if (attempts + 1 >= MAX_ATTEMPTS) await store.markFailed(job.id, message);
    else await store.rescheduleUpload(job.id, Date.now() + 5000 * 2 ** attempts, message, true);
  }

  /** Builds the thumbnail of a restored photo that Telegram has none for. */
  private async runPreview(job: PhotoRow): Promise<void> {
    const { store, storage, media } = this.deps;
    try {
      if (job.size > PREVIEW_DOWNLOAD_LIMIT || job.tg_message_id === null) {
        await store.markPreviewResult(job.id, 'unavailable');
        return;
      }
      const { stream } = await storage.getPhoto(this.deps.context(), job.tg_message_id);
      const original = await collectBlob(stream, job.mime);
      const shown = await mediaLimiter(() => media.makePreviews(original, job.mime));
      const meta = await media.readMetadata(original);
      if (shown) {
        await store.cacheThumb(job.sha256, shown.thumb);
        await store.cachePreview(job.sha256, shown.preview);
      }
      const { takenAt: _takenAt, exifWidth, exifHeight, ...camera } = meta;
      await store.markPreviewResult(job.id, shown ? 'ready' : 'unavailable', {
        ...camera,
        width: shown?.width ?? exifWidth,
        height: shown?.height ?? exifHeight,
      });
    } catch (err) {
      if (this.stopped) return;
      if (err instanceof SessionRevokedError) {
        this.deps.onRevoked();
      } else if (err instanceof RateLimitedError) {
        this.pausedUntil = Date.now() + (err.seconds + 1) * 1000;
      } else if ((await store.bumpPreviewAttempt(job.id)) >= MAX_PREVIEW_ATTEMPTS) {
        await store.markPreviewResult(job.id, 'unavailable');
      }
    } finally {
      this.previewRunning = false;
    }
  }
}
