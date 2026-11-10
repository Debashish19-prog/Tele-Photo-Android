import { createHash } from 'node:crypto';
import { Engine, type IngestResult } from '../src/engine/index';
import { FakeStorage, type FakeDisk, memoryDisk } from '../src/engine/fake';
import { readMetadata, sniffMedia, type MediaTools, type Previews } from '../src/engine/media';
import type { SplitPolicy } from '../src/engine/pieces';

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
export const blobBytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

function exifBlock(date?: string, camera?: string): Uint8Array {
  const ascii = (s: string) => new TextEncoder().encode(`${s}\0`);
  const make = ascii('Canon');
  const model = ascii(camera ?? '');
  const taken = ascii(date ?? '');
  const ifd0Count = (camera ? 2 : 0) + (date ? 1 : 0);
  const ifd0End = 8 + 2 + ifd0Count * 12 + 4;
  const makeAt = ifd0End;
  const modelAt = makeAt + (camera ? make.length : 0);
  const exifIfdAt = modelAt + (camera ? model.length : 0);
  const exifEnd = exifIfdAt + (date ? 2 + 12 + 4 : 0);
  const buffer = new Uint8Array(exifEnd + (date ? taken.length : 0));
  const view = new DataView(buffer.buffer);
  buffer.set([0x49, 0x49, 0x2a, 0], 0);
  view.setUint32(4, 8, true);
  view.setUint16(8, ifd0Count, true);
  let entry = 10;
  const write = (tag: number, type: number, count: number, value: number) => {
    view.setUint16(entry, tag, true);
    view.setUint16(entry + 2, type, true);
    view.setUint32(entry + 4, count, true);
    view.setUint32(entry + 8, value, true);
    entry += 12;
  };
  if (camera) {
    write(0x010f, 2, make.length, makeAt);
    write(0x0110, 2, model.length, modelAt);
    buffer.set(make, makeAt);
    buffer.set(model, modelAt);
  }
  if (date) {
    write(0x8769, 4, 1, exifIfdAt);
    view.setUint16(exifIfdAt, 1, true);
    entry = exifIfdAt + 2;
    write(0x9003, 2, taken.length, exifEnd);
    buffer.set(taken, exifEnd);
  }
  const header = new TextEncoder().encode('Exif\0\0');
  const app1 = new Uint8Array(4 + header.length + buffer.length);
  app1.set([0xff, 0xe1, (app1.length - 2) >> 8, (app1.length - 2) & 0xff], 0);
  app1.set(header, 4);
  app1.set(buffer, 4 + header.length);
  return app1;
}

/**
 * A small file that really is a JPEG as far as its header and EXIF go. Pixels are only tested in a
 * real browser. `color` just makes the bytes differ, so two calls can be different photos.
 */
export function makeJpeg(options: { color?: string; width?: number; height?: number; date?: string; camera?: string } = {}): Uint8Array {
  const { color = '#336699', width = 64, height = 48, date, camera } = options;
  const comment = new TextEncoder().encode(color);
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  if (date || camera) parts.push(exifBlock(date, camera));
  parts.push(new Uint8Array([0xff, 0xfe, 0, comment.length + 2]), comment);
  parts.push(new Uint8Array([0xff, 0xc0, 0, 11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]));
  parts.push(new Uint8Array([0xff, 0xd9]));
  return new Uint8Array(Buffer.concat(parts));
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  for (let i = 2; i + 8 < bytes.length; ) {
    if (bytes[i] !== 0xff) return null;
    if (bytes[i + 1] === 0xc0) return { height: (bytes[i + 5]! << 8) | bytes[i + 6]!, width: (bytes[i + 7]! << 8) | bytes[i + 8]! };
    i += 2 + ((bytes[i + 2]! << 8) | bytes[i + 3]!);
  }
  return null;
}

/** Everything real except the pixel work, which needs a browser and is tested in one. */
export const testMedia: MediaTools = {
  sniffMedia,
  readMetadata,
  async makePreviews(file, mime): Promise<Previews | null> {
    const size = mime.startsWith('video/') ? { width: 1920, height: 1080 } : jpegSize(await blobBytes(file));
    if (!size) return null;
    return { ...size, thumb: new Blob(['grid-thumb'], { type: 'image/webp' }), preview: new Blob(['viewer-preview'], { type: 'image/webp' }), telegramThumb: new Blob(['telegram-thumb'], { type: 'image/jpeg' }) };
  },
};

/**
 * The start of a real MP4 as far as anything here looks: a file type box, a movie header holding
 * when it was recorded, and `size` bytes of video data that differ from one `seed` to the next.
 * The header goes after the data when `moovAtEnd` is set, as it does in many cameras' files.
 */
export function makeMp4(options: { size?: number; seed?: number; recordedAt?: Date; wideMvhd?: boolean; moovAtEnd?: boolean } = {}): Uint8Array {
  const { size = 1000, seed = 1, recordedAt = new Date(Date.UTC(2023, 2, 4, 5, 6, 7)), wideMvhd = false, moovAtEnd = false } = options;
  const box = (name: string, body: Uint8Array) => {
    const out = Buffer.alloc(8 + body.length);
    out.writeUInt32BE(out.length, 0);
    out.write(name, 4, 'latin1');
    out.set(body, 8);
    return out;
  };
  const seconds = Math.floor(recordedAt.getTime() / 1000) + 2_082_844_800;
  const body = Buffer.alloc(wideMvhd ? 112 : 100);
  body.writeUInt8(wideMvhd ? 1 : 0, 0);
  if (wideMvhd) body.writeBigUInt64BE(BigInt(seconds), 4);
  else body.writeUInt32BE(seconds, 4);
  const ftyp = box('ftyp', new Uint8Array(Buffer.from('mp42\0\0\0\0mp42isom', 'latin1')));
  const moov = box('moov', new Uint8Array(box('mvhd', new Uint8Array(body))));
  const data = Buffer.alloc(size);
  let x = seed * 2654435761;
  for (let i = 0; i < size; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    data[i] = x >>> 24;
  }
  const mdat = box('mdat', new Uint8Array(data));
  return new Uint8Array(Buffer.concat(moovAtEnd ? [ftyp, mdat, moov] : [ftyp, moov, mdat]));
}

let counter = 0;

/** A browser profile: its own local database, talking to one shared pretend Telegram. */
export class Device {
  engine!: Engine;
  readonly storage: FakeStorage;
  dbName = `tp-test-${process.pid}-${++counter}`;
  private split: SplitPolicy | undefined;

  constructor(readonly disk: FakeDisk = memoryDisk(), storage?: FakeStorage) {
    this.storage = storage ?? new FakeStorage(disk);
  }

  async open(options: { trashRetentionDays?: number; split?: SplitPolicy } = {}): Promise<this> {
    this.split = options.split ?? this.split;
    this.engine = await Engine.open({ storage: this.storage, configured: true, media: testMedia, dbName: this.dbName, ...options, split: this.split });
    return this;
  }

  /** Closes this tab, keeping what is saved. Files it was holding are gone, as with a real tab. */
  async reload(): Promise<void> {
    await this.engine.close();
    await this.open();
  }

  /** The browser's data is cleared, or this is a brand new device. Telegram is untouched. */
  async wipeBrowser(): Promise<void> {
    await this.engine.close();
    this.dbName = `tp-test-${process.pid}-${++counter}`;
    await this.open();
  }

  async close(): Promise<void> {
    await this.engine.close();
  }

  async signIn(phone = '+15550000001'): Promise<void> {
    const { loginId } = await this.engine.sendCode(phone);
    const result = await this.engine.submitCode(loginId, '12345');
    if (result.status !== 'ok') throw new Error('expected no password step');
    await this.engine.whenIdle();
  }

  add(bytes: Uint8Array, filename = 'photo.jpg', lastModified: string | null = null): Promise<IngestResult> {
    return this.engine.ingest(new Blob([bytes as BlobPart]), filename, lastModified);
  }

  /** Uploads into an album from outside the library, keeping the photo out of Photos. */
  addInto(albumId: number, bytes: Uint8Array, filename = 'photo.jpg'): Promise<IngestResult> {
    return this.engine.ingest(new Blob([bytes as BlobPart]), filename, null, undefined, { albumId });
  }

  async addOk(bytes: Uint8Array, filename = 'photo.jpg', lastModified: string | null = null): Promise<number> {
    return (await this.add(bytes, filename, lastModified)).id;
  }

  async stored(bytes: Uint8Array, filename = 'photo.jpg'): Promise<number> {
    const id = await this.addOk(bytes, filename);
    await this.engine.queue.drain();
    return id;
  }

  names(query: Parameters<Engine['photos']>[0] = {}): string[] {
    return this.engine.photos(query).map((p) => p.filename);
  }

  /** Pushes this device's changes up, as its timer would a few seconds later. */
  async saveState(): Promise<void> {
    await this.engine.sync.flush();
  }

  /** Reads what other devices have done, as coming back to the app would. */
  async catchUp(): Promise<void> {
    await this.engine.sync.pull();
    this.engine.library.startScan({ full: false });
    await this.engine.whenIdle();
  }
}
