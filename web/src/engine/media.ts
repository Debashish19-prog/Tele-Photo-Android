import exifr from 'exifr';
import { fileTypeFromBlob } from 'file-type';
import { createSHA256 } from 'hash-wasm';
import type { CameraMeta } from './store';

const THUMB_HEIGHT = 512;
const THUMB_MAX_WIDTH = 1024;
const PREVIEW_EDGE = 2560;
/** What Telegram accepts as a document's thumbnail: a JPEG, at most 320 px on a side and 200 KB. */
const TELEGRAM_THUMB_EDGE = 320;
const TELEGRAM_THUMB_MAX_BYTES = 200 * 1024;
/** Past this a HEIC is decoded into too much memory to be worth previewing. It is still stored. */
const HEIC_DECODE_LIMIT_BYTES = 300 * 1024 * 1024;
/**
 * A browser reads the whole file into memory to try decoding it, which would take a phone down on
 * a huge one. A real photo this large is almost always a RAW with an embedded preview anyway.
 */
const BROWSER_DECODE_LIMIT_BYTES = 512 * 1024 * 1024;
/** Cameras put the embedded preview near the start of a file. */
const EMBEDDED_PREVIEW_SEARCH_BYTES = 32 * 1024 * 1024;
const HASH_CHUNK_BYTES = 8 * 1024 * 1024;
/** Longer than any sensible video takes to open, and short enough that one that never does cannot hold up the upload. */
const VIDEO_FRAME_TIMEOUT_MS = 20_000;
/** Seconds between the MP4 epoch of 1904 and the Unix one. */
const MP4_EPOCH_OFFSET = 2_082_844_800;
/** No real file has more boxes than this before its metadata, so this only ever stops a damaged one. */
const MP4_MAX_BOXES = 256;

export interface PhotoMetadata extends CameraMeta {
  takenAt: string | null;
  exifWidth: number | null;
  exifHeight: number | null;
}

export interface Previews {
  width: number;
  height: number;
  /** For the grid. */
  thumb: Blob;
  /** For the viewer. */
  preview: Blob;
  /** Goes to Telegram with the photo, so other devices can show it. */
  telegramThumb: Blob;
}

/** The parts that need a real browser are behind this, so the engine's logic can be tested without one. */
export interface MediaTools {
  sniffMedia(file: Blob): Promise<{ mime: string; ext: string } | null>;
  readMetadata(file: Blob, mime: string): Promise<PhotoMetadata>;
  makePreviews(file: Blob, mime: string): Promise<Previews | null>;
}

const EMPTY_METADATA: PhotoMetadata = {
  takenAt: null, camera_make: null, camera_model: null, lens: null, iso: null, f_number: null,
  exposure_time: null, focal_length: null, gps_lat: null, gps_lon: null, exifWidth: null, exifHeight: null,
};

/** Runs a limited number of heavy tasks at once, so a big batch cannot exhaust memory. */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** Thumbnails are CPU and memory heavy, so this is shared by everything that makes them. */
export const mediaLimiter = createLimiter(2);

/** Reads a piece at a time, so a 2 GB file never has to fit in memory. */
export async function hashBlob(file: Blob, onProgress?: (fraction: number) => void): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK_BYTES) {
    hasher.update(new Uint8Array(await file.slice(offset, offset + HASH_CHUNK_BYTES).arrayBuffer()));
    onProgress?.(Math.min(1, (offset + HASH_CHUNK_BYTES) / file.size));
  }
  return hasher.digest('hex');
}

/** Looks at the file's actual bytes, because a browser's name and type can say anything. */
export async function sniffMedia(file: Blob): Promise<{ mime: string; ext: string } | null> {
  const type = await fileTypeFromBlob(file).catch(() => undefined);
  if (!type?.mime.startsWith('image/') && !type?.mime.startsWith('video/')) return null;
  return { mime: type.mime, ext: type.ext };
}

const text = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const trimmed = v.replace(/\0/g, '').trim();
  return trimmed || null;
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** EXIF dates have no zone and mean the local time at the camera, so they are kept exactly as written. */
export function parseExifDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (Number(y) < 1800 || mo === '00' || d === '00') return null;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

/** Walks a run of MP4 boxes looking for one type, reading only their headers, as a box can be gigabytes long. */
async function findMp4Box(file: Blob, type: string, from: number, to: number): Promise<{ start: number; end: number } | null> {
  let at = from;
  for (let seen = 0; seen < MP4_MAX_BOXES && at + 8 <= to; seen++) {
    const header = new DataView(await file.slice(at, at + 16).arrayBuffer());
    const name = String.fromCharCode(header.getUint8(4), header.getUint8(5), header.getUint8(6), header.getUint8(7));
    const short = header.getUint32(0);
    const wide = short === 1;
    const size = wide ? Number(header.getBigUint64(8)) : short === 0 ? to - at : short;
    const start = at + (wide ? 16 : 8);
    if (size < start - at) return null;
    if (name === type) return { start, end: at + size };
    at += size;
  }
  return null;
}

/**
 * When an MP4 or MOV was recorded, from its movie header. It is the nearest thing a video has to a
 * photo's EXIF date. It is stored as UTC, unlike EXIF, so this converts it to the local wall clock.
 */
export async function readVideoDate(file: Blob): Promise<string | null> {
  try {
    const moov = await findMp4Box(file, 'moov', 0, file.size);
    const mvhd = moov && (await findMp4Box(file, 'mvhd', moov.start, moov.end));
    if (!mvhd) return null;
    const header = new DataView(await file.slice(mvhd.start, mvhd.start + 12).arrayBuffer());
    const seconds = header.getUint8(0) === 1 ? Number(header.getBigUint64(4)) : header.getUint32(4);
    const unix = seconds - MP4_EPOCH_OFFSET;
    // Devices with no clock set write zero, or a date from long before they were made.
    if (unix < Date.UTC(1990, 0, 1) / 1000 || unix * 1000 > Date.now() + 86_400_000) return null;
    const date = new Date(unix * 1000);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  } catch {
    return null;
  }
}

export async function readMetadata(file: Blob, mime: string): Promise<PhotoMetadata> {
  if (mime.startsWith('video/')) return { ...EMPTY_METADATA, takenAt: await readVideoDate(file) };
  try {
    const t = await exifr.parse(new Uint8Array(await file.slice(0, EMBEDDED_PREVIEW_SEARCH_BYTES).arrayBuffer()), {
      tiff: true, exif: true, gps: true, ifd1: false, interop: false, xmp: false, icc: false,
      iptc: false, jfif: false, ihdr: false, reviveValues: false, translateValues: false, mergeOutput: true,
    });
    if (!t) return EMPTY_METADATA;
    return {
      takenAt: parseExifDate(t.DateTimeOriginal) ?? parseExifDate(t.CreateDate) ?? parseExifDate(t.DateTime) ?? parseExifDate(t.ModifyDate),
      camera_make: text(t.Make),
      camera_model: text(t.Model),
      lens: text(t.LensModel),
      iso: num(t.ISO),
      f_number: num(t.FNumber),
      exposure_time: num(t.ExposureTime),
      focal_length: num(t.FocalLength),
      gps_lat: num(t.latitude),
      gps_lon: num(t.longitude),
      exifWidth: num(t.ExifImageWidth) ?? num(t.ImageWidth),
      exifHeight: num(t.ExifImageHeight) ?? num(t.ImageHeight),
    };
  } catch {
    return EMPTY_METADATA;
  }
}

const isHeic = (mime: string) => mime === 'image/heic' || mime === 'image/heif' || mime === 'image/heic-sequence' || mime === 'image/heif-sequence';

/** Fits inside the limits without ever scaling a small photo up. */
export function fitInside(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function encode(bitmap: ImageBitmap, target: { width: number; height: number }, type: string, quality: number): Promise<Blob> {
  const draw = (context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => {
    context.imageSmoothingQuality = 'high';
    // A JPEG has no transparency, and a PNG's would otherwise come out black.
    if (type === 'image/jpeg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, target.width, target.height);
    }
    context.drawImage(bitmap, 0, 0, target.width, target.height);
  };
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(target.width, target.height);
    draw(canvas.getContext('2d')!);
    return canvas.convertToBlob({ type, quality });
  }
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  draw(canvas.getContext('2d')!);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The browser could not encode this image'))), type, quality);
  });
}

/** Safari cannot write WebP and quietly hands back a large PNG instead, so that gets redone as a JPEG. */
async function encodeWeb(bitmap: ImageBitmap, target: { width: number; height: number }, quality: number): Promise<Blob> {
  const webp = await encode(bitmap, target, 'image/webp', quality);
  return webp.type === 'image/webp' ? webp : encode(bitmap, target, 'image/jpeg', quality);
}

async function encodeTelegramThumb(bitmap: ImageBitmap): Promise<Blob> {
  const target = fitInside(bitmap.width, bitmap.height, TELEGRAM_THUMB_EDGE, TELEGRAM_THUMB_EDGE);
  let thumb = await encode(bitmap, target, 'image/jpeg', 0.8);
  for (const quality of [0.6, 0.4, 0.25]) {
    if (thumb.size <= TELEGRAM_THUMB_MAX_BYTES) break;
    thumb = await encode(bitmap, target, 'image/jpeg', quality);
  }
  return thumb;
}

/**
 * A frame from a little way in, as many videos open on black. The browser reads only what it needs
 * of the file, so the size does not matter. Null if this browser cannot play the format.
 */
function videoFrame(file: Blob): Promise<ImageBitmap | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const finish = (bitmap: ImageBitmap | null) => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(bitmap);
    };
    const timer = setTimeout(() => finish(null), VIDEO_FRAME_TIMEOUT_MS);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onerror = () => finish(null);
    video.onloadedmetadata = () => {
      if (video.videoWidth === 0) finish(null);
      // A file written as it was recorded may not know how long it is.
      else video.currentTime = Number.isFinite(video.duration) ? Math.min(1, video.duration / 2) : 0.1;
    };
    video.onseeked = () => void createImageBitmap(video).then(finish, () => finish(null));
    video.src = url;
  });
}

/** Tries what the browser can read itself, then libheif for iPhone photos, then a camera's embedded JPEG. */
async function decode(file: Blob, mime: string): Promise<ImageBitmap | null> {
  if (mime.startsWith('video/')) return videoFrame(file);

  if (file.size <= BROWSER_DECODE_LIMIT_BYTES) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Fall through to the slower ways of reading it.
    }
  }

  if (isHeic(mime) && file.size <= HEIC_DECODE_LIMIT_BYTES) {
    try {
      // Only fetched when needed, as this is 2 MB of WASM most sessions never use.
      const { default: decodeHeic } = await import('heic-decode');
      const decoded = await decodeHeic({ buffer: new Uint8Array(await file.arrayBuffer()) });
      const pixels = new Uint8ClampedArray(decoded.data.buffer as ArrayBuffer, decoded.data.byteOffset, decoded.data.byteLength);
      return await createImageBitmap(new ImageData(pixels, decoded.width, decoded.height));
    } catch {
      // Fall through.
    }
  }

  try {
    const head = new Uint8Array(await file.slice(0, EMBEDDED_PREVIEW_SEARCH_BYTES).arrayBuffer());
    const embedded = await exifr.thumbnail(head);
    if (!embedded) return null;
    return await createImageBitmap(new Blob([embedded as BlobPart], { type: 'image/jpeg' }), { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
}

/**
 * Writes the web-sized copies the app displays. These only ever affect what is shown. The original
 * is never touched by this function.
 *
 * Returns null if nothing in the chain could read the file. That does not fail the upload: it is
 * stored in Telegram regardless and gets a placeholder tile.
 */
export async function makePreviews(file: Blob, mime: string): Promise<Previews | null> {
  const bitmap = await decode(file, mime);
  if (!bitmap) return null;
  try {
    const { width, height } = bitmap;
    const preview = await encodeWeb(bitmap, fitInside(width, height, PREVIEW_EDGE, PREVIEW_EDGE), 0.84);
    const thumb = await encodeWeb(bitmap, fitInside(width, height, THUMB_MAX_WIDTH, THUMB_HEIGHT), 0.74);
    const telegramThumb = await encodeTelegramThumb(bitmap);
    return { width, height, thumb, preview, telegramThumb };
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

export const browserMedia: MediaTools = { sniffMedia, readMetadata, makePreviews };
