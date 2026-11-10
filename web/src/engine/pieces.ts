import { createSHA256 } from 'hash-wasm';
import type { PhotoRow } from './store';
import { type StorageBackend, type StorageContext, UserFacingError } from './types';

/**
 * The most a non-Premium account can upload as a single file: 4000 parts of 512 KiB.
 * This is 2,097,152,000 bytes (about 1.95 GiB). Anything larger fails on Telegram's side
 * with FILE_PARTS_INVALID, so a larger video has to go in pieces.
 */
export const MAX_PHOTO_BYTES = 4000 * 512 * 1024;

/**
 * Well under the ceiling, because an interrupted piece starts again from its beginning.
 * An upload in progress assumes its earlier pieces were cut to this size, so a change only
 * suits a new release if nobody is likely to be partway through one.
 */
const PIECE_BYTES = 1024 ** 3;

/** What a piece is sent as. Only the first would make any sense to a player, so none of them claim to be video. */
export const PIECE_MIME = 'application/octet-stream';

/** Telegram serves a file 512 KiB at a time, from offsets that line up with this. */
const READ_BLOCK_BYTES = 512 * 1024;
/** How many blocks one read fetches side by side. */
const READ_MAX_BLOCKS = 4;
/** About 16 MB, which is plenty for the stretches a player asks for repeatedly while it settles after a seek. */
const CACHED_BLOCKS = 32;

export interface SplitPolicy {
  /** Anything up to this size goes as one message. */
  maxSingleBytes: number;
  pieceBytes: number;
}

export const TELEGRAM_SPLIT: SplitPolicy = { maxSingleBytes: MAX_PHOTO_BYTES, pieceBytes: PIECE_BYTES };

export interface StoredPiece {
  messageId: number;
  size: number;
}

/** Where each piece of a file falls. A file Telegram can take whole is a single piece. */
export function planPieces(size: number, policy: SplitPolicy): { start: number; end: number }[] {
  if (size <= policy.maxSingleBytes) return [{ start: 0, end: size }];
  const plan: { start: number; end: number }[] = [];
  for (let start = 0; start < size; start += policy.pieceBytes) plan.push({ start, end: Math.min(start + policy.pieceBytes, size) });
  return plan;
}

/** Numbered so that they sort, and so that `cat clip.mp4.* > clip.mp4` rebuilds the video even without this app. */
export function pieceName(filename: string, index: number): string {
  return `${filename}.${String(index + 1).padStart(3, '0')}`;
}

export function wholeName(pieceFilename: string): string {
  return pieceFilename.replace(/\.\d{3,}$/, '');
}

/** Every message holding part of this file, including those of an upload that has not finished. */
export function piecesOf(photo: Pick<PhotoRow, 'tg_parts' | 'tg_message_id' | 'size'>): StoredPiece[] {
  if (photo.tg_parts) return photo.tg_parts;
  return photo.tg_message_id === null ? [] : [{ messageId: photo.tg_message_id, size: photo.size }];
}

/** Finds which piece holds `start`, and how much of the range that piece can answer in one read. */
export function locateRange(pieces: StoredPiece[], start: number, end: number): { messageId: number; pieceSize: number; start: number; end: number } | null {
  let at = 0;
  for (const piece of pieces) {
    if (start < at + piece.size) {
      const inner = start - at;
      const furthest = (Math.floor(inner / READ_BLOCK_BYTES) + READ_MAX_BLOCKS) * READ_BLOCK_BYTES;
      return { messageId: piece.messageId, pieceSize: piece.size, start: inner, end: Math.min(end - at, piece.size, furthest) };
    }
    at += piece.size;
  }
  return null;
}

/**
 * The blocks of video read most recently. A player asks for the same stretch again and again as it
 * finds its place, and without this each of those would be another round of requests to Telegram,
 * which is both slow and what gets an account rate limited.
 */
export class BlockCache {
  private readonly blocks = new Map<string, Promise<Uint8Array>>();

  constructor(private readonly storage: StorageBackend) {}

  clear(): void {
    this.blocks.clear();
  }

  async read(ctx: StorageContext, spot: NonNullable<ReturnType<typeof locateRange>>): Promise<Uint8Array> {
    const first = Math.floor(spot.start / READ_BLOCK_BYTES);
    const last = Math.ceil(spot.end / READ_BLOCK_BYTES);
    const wanted = Array.from({ length: last - first }, (_, i) => first + i);
    const blocks = await Promise.all(wanted.map((block) => this.block(ctx, spot.messageId, spot.pieceSize, block)));

    const joined = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
    let at = 0;
    for (const block of blocks) {
      joined.set(block, at);
      at += block.length;
    }
    const skip = spot.start - first * READ_BLOCK_BYTES;
    return joined.subarray(skip, skip + (spot.end - spot.start));
  }

  private block(ctx: StorageContext, messageId: number, pieceSize: number, block: number): Promise<Uint8Array> {
    // Message ids are only unique within a channel, and this outlives a change of account.
    const key = `${ctx.library.channelId}/${messageId}/${block}`;
    const held = this.blocks.get(key);
    if (held) {
      // To the back of the line, as the Map keeps the order things were added in.
      this.blocks.delete(key);
      this.blocks.set(key, held);
      return held;
    }
    const start = block * READ_BLOCK_BYTES;
    const loading = this.storage.getPhotoRange(ctx, messageId, start, Math.min(start + READ_BLOCK_BYTES, pieceSize));
    // A failure may well not happen next time, so it is not something to remember.
    loading.catch(() => this.blocks.delete(key));
    this.blocks.set(key, loading);
    if (this.blocks.size > CACHED_BLOCKS) this.blocks.delete(this.blocks.keys().next().value!);
    return loading;
  }
}

export async function* joinPieces(storage: StorageBackend, ctx: StorageContext, pieces: StoredPiece[]): AsyncIterable<Uint8Array> {
  for (const piece of pieces) {
    const { stream } = await storage.getPhoto(ctx, piece.messageId);
    yield* stream;
  }
}

/**
 * Passes bytes along while hashing them, and fails at the very end if they are not what was
 * uploaded. Failing there matters: a save to disk is abandoned instead of leaving a damaged video.
 */
export async function* checkedAgainst(sha256: string, source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  const hasher = await createSHA256();
  hasher.init();
  for await (const chunk of source) {
    hasher.update(chunk);
    yield chunk;
  }
  if (hasher.digest('hex') !== sha256) {
    throw new UserFacingError('PIECES_DAMAGED', 'The pieces of this video in Telegram do not add up to the original, so it was not saved.', 422);
  }
}
