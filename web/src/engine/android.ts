import { Buffer } from 'buffer';
import { type AutoSyncStatus, type GalleryAccess, type GalleryHost, type GalleryItem, GalleryReadError, type NetworkState, type PassOutcome } from './autosync';

const LIST_PAGE = 1000;
const SAVE_CHUNK_BYTES = 512 * 1024;

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
  /** JSON rows of [id, name, size, modified, taken], after an id, in ascending order. */
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

/** Reads the original through the app, which refuses rather than hand over a copy without its location. */
async function readOriginal(item: GalleryItem): Promise<Blob> {
  const response = await fetch(`/_gallery/${item.id}`, { cache: 'no-store' }).catch((err: Error) => {
    throw new GalleryReadError('failed', err.message);
  });
  if (response.status === 404) throw new GalleryReadError('gone', 'This file is no longer on the phone.');
  if (response.status === 403) throw new GalleryReadError('denied', 'Android would not give access to the original file.');
  if (!response.ok) throw new GalleryReadError('failed', `The phone could not read this file (${response.status}).`);

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
        const rows = JSON.parse(bridge.listGallery(after, LIST_PAGE)) as [number, string, number, number, number | null][];
        if (rows.length === 0) return items;
        for (const [id, name, size, modified, taken] of rows) items.push({ id, name, size, modified, taken });
        after = rows[rows.length - 1]![0];
      }
    },
  };
}

/** A WebView has nowhere to send a download link, so saved files go through the app instead. */
export async function saveThroughApp(bridge: AndroidBridge, blob: Blob, filename: string): Promise<void> {
  const handle = bridge.beginSave(filename, blob.type || 'application/octet-stream');
  if (handle < 0) throw new Error('The phone could not create that file.');
  let ok = false;
  try {
    for (let at = 0; at < blob.size; at += SAVE_CHUNK_BYTES) {
      const chunk = new Uint8Array(await blob.slice(at, at + SAVE_CHUNK_BYTES).arrayBuffer());
      if (!bridge.writeSave(handle, Buffer.from(chunk).toString('base64'))) throw new Error('The phone could not save that file.');
    }
    ok = true;
  } finally {
    bridge.finishSave(handle, ok);
  }
}
