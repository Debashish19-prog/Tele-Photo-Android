import { Buffer } from 'buffer';
import { type AutoSyncStatus, type GalleryAccess, type GalleryHost, type GalleryItem, GalleryReadError, type NetworkState, type PassOutcome } from './autosync';
import type { PiecewiseFile } from './media';

const LIST_PAGE = 1000;
const SAVE_CHUNK_BYTES = 512 * 1024;
/** The most one request asks the phone for. A larger read is made of several. */
const READ_REQUEST_BYTES = 8 * 1024 * 1024;
/** Enough for a player or a download to keep moving, small enough to hold no more than that. */
const STREAM_READ_BYTES = 1024 * 1024;

export type NativeEventName = 'run' | 'pause' | 'access-changed' | 'back';

/** The Kotlin side of the app. See Bridge.kt. Its methods are called directly and return at once. */
export interface AndroidBridge {
  ready(): void;
  access(): GalleryAccess;
  network(): NetworkState;
  /** JSON: enabled, mobileData, batteryExempt. */
  settings(): string;
  setEnabled(enabled: boolean): void;
  setMobileData(allowed: boolean): void;
  requestAccess(): void;
  requestBatteryExemption(): void;
  openAppSettings(): void;
  /** JSON rows of [id, name, size, modified, taken, kind], after an id, in ascending order. */
  listGallery(afterId: number, limit: number): string;
  report(status: string): void;
  finished(outcome: string): void;
  beginSave(name: string, mime: string): number;
  writeSave(handle: number, base64: string): boolean;
  finishSave(handle: number, ok: boolean): boolean;
}

declare global {
  interface Window {
    TelePhotoAndroid?: AndroidBridge;
    /** How the Kotlin side gets a message to this page. */
    telePhotoNative?: (event: NativeEventName) => boolean | void;
  }
}

export const androidBridge = (): AndroidBridge | null => (typeof window === 'undefined' ? null : (window.TelePhotoAndroid ?? null));

export const isAndroidApp = (): boolean => androidBridge() !== null;

const nativeHandlers = new Map<NativeEventName, () => void>();

/** For anything that does not have to wait for the engine, like the back button. */
export function onNativeEvent(event: NativeEventName, handler: () => void): void {
  nativeHandlers.set(event, handler);
}

/** Dialogs, menus and the photo viewer all close on Escape, so that is how Back closes them too. */
function closeWhateverIsOnTop(): boolean {
  const open = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"]')].some((el) => el.checkVisibility());
  if (!open) return false;
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  return true;
}

if (androidBridge()) {
  window.telePhotoNative = (event) => {
    if (event === 'back') return closeWhateverIsOnTop();
    nativeHandlers.get(event)?.();
    return true;
  };
}

export interface AndroidSettings {
  enabled: boolean;
  mobileData: boolean;
  batteryExempt: boolean;
}

export const androidSettings = (bridge: AndroidBridge): AndroidSettings => JSON.parse(bridge.settings()) as AndroidSettings;

/** Asks the app for a gallery file, turning its refusals into the reasons autosync acts on. */
async function askPhone(url: string): Promise<Response> {
  const response = await fetch(url, { cache: 'no-store' }).catch((err: Error) => {
    throw new GalleryReadError('failed', err.message);
  });
  if (response.status === 404) throw new GalleryReadError('gone', 'This file is no longer on the phone.');
  if (response.status === 403) throw new GalleryReadError('denied', 'Android would not give access to the original file.');
  // 416 is a file that got shorter, which is also a change.
  if (response.status === 409 || response.status === 416) throw new GalleryReadError('changed', 'The file changed on the phone while it was being backed up. The new version is backed up instead.');
  if (!response.ok) throw new GalleryReadError('failed', `The phone could not read this file (${response.status}).`);
  return response;
}

interface GallerySource {
  id: number;
  /** The whole file's size. */
  size: number;
  /** Changes whenever the file does. Every read is refused once it no longer matches. */
  version: string;
}

/** Exactly the bytes from `start` up to `end`, or an error. Never fewer, and never from another version. */
async function readGalleryRange(source: GallerySource, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
  const response = await askPhone(`/_gallery/${source.id}?start=${start}&end=${end}&version=${encodeURIComponent(source.version)}`);
  const bytes = new Uint8Array(await response.arrayBuffer().catch((err: Error) => {
    throw new GalleryReadError('failed', err.message);
  }));
  if (bytes.byteLength !== end - start) throw new GalleryReadError('failed', 'The phone did not return the whole of what was asked for.');
  return bytes;
}

/**
 * A video in the phone's gallery, read straight from it a piece at a time as each is wanted, so a
 * file of many gigabytes never has to be copied, or fit anywhere, to be backed up.
 *
 * It stands in for a Blob, and the engine only ever reads a file through slice and arrayBuffer,
 * which this answers itself. A browser API given one directly would see an empty file, which is
 * why only videos come as these, and why nothing that decodes a file is ever handed one.
 */
export class GalleryFile extends Blob implements PiecewiseFile {
  readonly piecewise = true as const;

  constructor(
    private readonly source: GallerySource,
    private readonly from = 0,
    private readonly to = source.size,
    private readonly contentType = '',
  ) {
    super();
  }

  override get size(): number {
    return this.to - this.from;
  }

  override get type(): string {
    return this.contentType;
  }

  /** The same rules as Blob.slice, counting from the end for a negative position. */
  override slice(start?: number, end?: number, contentType?: string): GalleryFile {
    const size = this.size;
    const place = (at: number | undefined, otherwise: number) => {
      if (at === undefined) return otherwise;
      const whole = Math.trunc(at);
      return whole < 0 ? Math.max(size + whole, 0) : Math.min(whole, size);
    };
    const first = place(start, 0);
    const last = Math.max(first, place(end, size));
    return new GalleryFile(this.source, this.from + first, this.from + last, contentType ?? '');
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    return (await this.bytes()).buffer;
  }

  override async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    const out = new Uint8Array(this.size);
    for (let at = 0; at < this.size; at += READ_REQUEST_BYTES) {
      const end = Math.min(this.size, at + READ_REQUEST_BYTES);
      out.set(await readGalleryRange(this.source, this.from + at, this.from + end), at);
    }
    return out;
  }

  override async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    let at = 0;
    return new ReadableStream({
      pull: async (controller) => {
        if (at >= this.size) {
          controller.close();
          return;
        }
        const end = Math.min(this.size, at + STREAM_READ_BYTES);
        controller.enqueue(await readGalleryRange(this.source, this.from + at, this.from + end));
        at = end;
      },
    });
  }

  async poster(edge: number): Promise<{ image: Blob; width: number; height: number } | null> {
    const response = await fetch(`/_gallery/${this.source.id}?poster=${edge}`, { cache: 'no-store' }).catch(() => null);
    if (!response?.ok) return null;
    return {
      image: await response.blob(),
      width: Number(response.headers.get('X-Tele-Photo-Width')) || 0,
      height: Number(response.headers.get('X-Tele-Photo-Height')) || 0,
    };
  }
}

/** Asks only for the size and version. Nothing of the video itself is read until it is wanted. */
async function openGalleryVideo(item: GalleryItem): Promise<GalleryFile> {
  const response = await askPhone(`/_gallery/${item.id}?start=0&end=0`);
  const size = Number(response.headers.get('X-Tele-Photo-Size'));
  const version = response.headers.get('X-Tele-Photo-Version');
  if (!Number.isSafeInteger(size) || size < 0 || !version) throw new GalleryReadError('failed', 'The phone did not say how large this file is.');
  return new GalleryFile({ id: item.id, size, version });
}

/** Reads the original through the app, which refuses rather than hand over a copy without its location. */
async function readOriginal(item: GalleryItem): Promise<Blob> {
  // A photo is small, and has to be decoded whole for its thumbnail, so it is read in one go.
  if (item.kind === 'video') return openGalleryVideo(item);
  const response = await askPhone(`/_gallery/${item.id}`);

  const blob = await response.blob().catch((err: Error) => {
    throw new GalleryReadError('failed', err.message);
  });
  // The file's size as it is on disk, in case the read stopped short, which nothing else would notice.
  const expected = Number(response.headers.get('X-Tele-Photo-Size'));
  if (!Number.isFinite(expected) || blob.size !== expected) throw new GalleryReadError('failed', 'The phone did not return the whole file.');
  return blob;
}

export function androidGallery(bridge: AndroidBridge): GalleryHost {
  return {
    access: () => bridge.access(),
    network: () => bridge.network(),
    settings: () => androidSettings(bridge),
    read: readOriginal,
    turnOff: () => bridge.setEnabled(false),
    report: (status: AutoSyncStatus) => bridge.report(JSON.stringify(status)),
    finished: (outcome: PassOutcome) => bridge.finished(JSON.stringify(outcome)),
    async list() {
      const items: GalleryItem[] = [];
      let after = 0;
      for (;;) {
        const rows = JSON.parse(bridge.listGallery(after, LIST_PAGE)) as [number, string, number, number, number | null, 'photo' | 'video'][];
        if (rows.length === 0) return items;
        for (const [id, name, size, modified, taken, kind] of rows) items.push({ id, name, size, modified, taken, kind });
        after = rows[rows.length - 1]![0];
      }
    },
  };
}

/**
 * A WebView has nowhere to send a download link, so saved files go through the app instead.
 * Streamed, because a video can be many times larger than the page could hold at once.
 */
export async function saveThroughApp(bridge: AndroidBridge, source: ReadableStream<Uint8Array>, filename: string, mime: string): Promise<void> {
  const handle = bridge.beginSave(filename, mime || 'application/octet-stream');
  if (handle < 0) {
    await source.cancel().catch(() => undefined);
    throw new Error('The phone could not create that file.');
  }
  const reader = source.getReader();
  let ok = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let at = 0; at < value.byteLength; at += SAVE_CHUNK_BYTES) {
        const chunk = value.subarray(at, at + SAVE_CHUNK_BYTES);
        if (!bridge.writeSave(handle, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64'))) throw new Error('The phone could not save that file.');
      }
    }
    ok = true;
  } finally {
    if (!ok) await reader.cancel().catch(() => undefined);
    bridge.finishSave(handle, ok);
  }
}
