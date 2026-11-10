import { ApiError, getEngine } from '@/api';
import { toWallClock } from '@/lib/format';

/** Telegram's single-file ceiling: 4000 parts of 512 KiB. A video over it goes in pieces, and a photo is refused. */
export const MAX_PHOTO_BYTES = 4000 * 512 * 1024;
const CONCURRENCY = 3;

/** Browsers leave the type blank for many camera formats, so these are recognised by name. */
const PHOTO_EXTENSIONS = /\.(jpe?g|png|gif|webp|avif|heic|heif|tiff?|bmp|jxl|dng|cr2|cr3|nef|arw|orf|rw2|raf|pef|srw)$/i;
/** Not .ts: a browser that knows the video format says so in the type, and otherwise it is far more likely to be code. */
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|ogv|3gp|3g2|mpe?g|mts|m2ts)$/i;

/** For a file picker's `accept`. */
export const ACCEPTED_FILES = 'image/*,video/*,.heic,.heif,.dng,.cr2,.cr3,.nef,.arw,.orf,.rw2,.raf,.pef,.srw,.mkv,.avi,.wmv,.flv,.mts,.m2ts';

export type LocalStage = 'waiting' | 'sending' | 'received' | 'duplicate' | 'restored' | 'error';

export interface LocalUpload {
  key: number;
  file: File | null;
  filename: string;
  size: number;
  stage: LocalStage;
  progress: number;
  error: string | null;
  photoId: number | null;
  /** The album this was uploaded into, which keeps it out of Photos. */
  albumId: number | null;
  retryOnly?: boolean;
}

type Listener = () => void;

/** Checks each file and makes its thumbnails. The engine's queue takes it from there to Telegram. */
class Uploader {
  private entries: LocalUpload[] = [];
  private readonly listeners = new Set<Listener>();
  private active = 0;
  private nextKey = 1;
  /** Called whenever a file is ready, so the grid can show it straight away. */
  onReceived: (() => void) | null = null;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = () => this.entries;

  private emit(): void {
    this.entries = [...this.entries];
    for (const listener of this.listeners) listener();
  }

  private patch(key: number, change: Partial<LocalUpload>): void {
    const entry = this.entries.find((e) => e.key === key);
    if (entry) Object.assign(entry, change);
    this.emit();
  }

  /** True while files are still being prepared. The engine's queue answers for what comes after. */
  get isBusy(): boolean {
    return this.entries.some((e) => e.stage === 'waiting' || e.stage === 'sending');
  }

  add(files: File[], albumId: number | null = null, options: { retryOnly?: boolean } = {}): { added: number; skipped: number } {
    let added = 0;
    let skipped = 0;
    for (const file of files) {
      const looksLikeVideo = file.type.startsWith('video/') || VIDEO_EXTENSIONS.test(file.name);
      const looksLikePhoto = file.type.startsWith('image/') || PHOTO_EXTENSIONS.test(file.name);
      if (!looksLikePhoto && !looksLikeVideo) {
        skipped++;
        continue;
      }
      const tooBig = file.size > MAX_PHOTO_BYTES && !looksLikeVideo;
      this.entries.push({
        key: this.nextKey++,
        file: tooBig ? null : file,
        filename: file.name,
        size: file.size,
        stage: tooBig ? 'error' : 'waiting',
        progress: 0,
        error: tooBig ? 'Larger than the 1.95 GB Telegram accepts in one file.' : null,
        photoId: null,
        albumId,
        retryOnly: options.retryOnly,
      });
      added++;
    }
    this.emit();
    this.pump();
    return { added, skipped };
  }

  retry(key: number): void {
    const entry = this.entries.find((e) => e.key === key);
    if (!entry?.file || entry.stage !== 'error') return;
    this.patch(key, { stage: 'waiting', progress: 0, error: null });
    this.pump();
  }

  dismiss(key: number): void {
    this.entries = this.entries.filter((e) => e.key !== key);
    this.emit();
  }

  /** Forgets everything that no longer needs attention. */
  clearSettled(isSettled: (entry: LocalUpload) => boolean): void {
    this.entries = this.entries.filter((e) => !isSettled(e));
    this.emit();
  }

  private pump(): void {
    while (this.active < CONCURRENCY) {
      const next = this.entries.find((e) => e.stage === 'waiting');
      if (!next) return;
      this.active++;
      this.patch(next.key, { stage: 'sending' });
      void this.send(next).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async send(entry: LocalUpload): Promise<void> {
    const file = entry.file!;
    try {
      const engine = await getEngine();
      const result = await engine.ingest(
        file,
        entry.filename,
        toWallClock(file.lastModified),
        (fraction) => this.patch(entry.key, { progress: fraction }),
        { ...(entry.albumId !== null ? { albumId: entry.albumId } : {}), retryOnly: entry.retryOnly },
      );
      this.patch(entry.key, {
        stage: result.restored ? 'restored' : result.duplicate ? 'duplicate' : 'received',
        progress: 1,
        photoId: result.id,
        // The queue holds its own reference, and this list does not need one any more.
        file: null,
      });
      this.onReceived?.();
    } catch (err) {
      // A file refused for what it is would be refused again, so there is nothing to retry.
      const permanent = err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429;
      this.patch(entry.key, {
        stage: 'error',
        error: err instanceof Error ? err.message : 'This file could not be read.',
        ...(permanent ? { file: null } : {}),
      });
    }
  }
}

export const uploader = new Uploader();

/** Walks a dropped folder, because dropping a whole folder is how a library usually moves in. */
export async function filesFromDrop(data: DataTransfer): Promise<File[]> {
  // Both are read before the first await: a browser empties a DataTransfer once the event is over.
  const entries = [...data.items].map((item) => item.webkitGetAsEntry()).filter((e): e is FileSystemEntry => e !== null);
  if (entries.length === 0) return [...data.files];
  const files: File[] = [];

  async function walk(entry: FileSystemEntry): Promise<void> {
    if (entry.isFile) {
      await new Promise<void>((resolve) => {
        (entry as FileSystemFileEntry).file(
          (file) => {
            files.push(file);
            resolve();
          },
          () => resolve(),
        );
      });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns at most about 100 at a time, so it must be called until it comes back empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
      if (batch.length === 0) return;
      for (const child of batch) await walk(child);
    }
  }

  for (const entry of entries) await walk(entry);
  return files;
}
