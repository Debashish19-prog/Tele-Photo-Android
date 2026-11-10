/**
 * Why a file on the phone could not be read. `changed` means it was edited while being read a
 * piece at a time, so what was read so far belongs to a version that no longer exists.
 */
export type GalleryReadProblem = 'gone' | 'denied' | 'changed' | 'failed';

export class GalleryReadError extends Error {
  constructor(readonly problem: GalleryReadProblem, message: string) {
    super(message);
  }
}

export interface LibraryRef {
  channelId: string;
  accessHash: string;
}

/** Everything a backend needs to act on the library. */
export interface StorageContext {
  session: string;
  library: LibraryRef;
}

export interface TelegramUser {
  id: string;
  firstName: string;
  lastName: string;
  username: string;
  phone: string;
}

export interface LoginSuccess {
  status: 'ok';
  session: string;
  user: TelegramUser;
}

export type CodeResult = LoginSuccess | { status: 'needs-password'; hint: string };

export interface PutPhotoInput {
  file: Blob;
  filename: string;
  mime: string;
  size: number;
  caption: string;
  /** A small JPEG stored with the photo, which is how another device gets a thumbnail without downloading the original. */
  thumb: Blob | null;
}

export interface ScannedPhoto {
  messageId: number;
  filename: string;
  size: number;
  mime: string;
  caption: string;
  /** Unix seconds, from the Telegram message. */
  date: number;
  /** Whether a real thumbnail can be fetched for this photo, rather than the original. */
  hasThumb: boolean;
}

export interface EnsureLibraryResult {
  library: LibraryRef;
  /** True when an existing library channel was found rather than created. */
  existing: boolean;
}

/** Identifies one saved copy of the synced state, so an unchanged copy need not be downloaded again. */
export interface StateVersion {
  messageId: number;
  version: number;
}

export interface StateFile extends StateVersion {
  bytes: Uint8Array;
}

export interface StorageBackend {
  readonly kind: 'telegram' | 'fake';

  sendLoginCode(phone: string): Promise<{ loginId: string; delivery: 'app' | 'other' }>;
  submitLoginCode(loginId: string, code: string): Promise<CodeResult>;
  submitLoginPassword(loginId: string, password: string): Promise<LoginSuccess>;

  ensureLibrary(session: string): Promise<EnsureLibraryResult>;
  /** Stores one file, or one piece of a large one, as exactly one message, byte for byte. Rejects if Telegram altered it. */
  putPhoto(ctx: StorageContext, input: PutPhotoInput, onProgress: (fraction: number) => void): Promise<{ messageId: number }>;
  getPhoto(ctx: StorageContext, messageId: number): Promise<{ size: number; stream: AsyncIterable<Uint8Array> }>;
  /** Just the bytes from `start` up to but not including `end`, which is what lets a video seek without downloading it all. */
  getPhotoRange(ctx: StorageContext, messageId: number, start: number, end: number): Promise<Uint8Array>;
  /** The thumbnail stored with a photo, or null if it has none. */
  getThumb(ctx: StorageContext, messageId: number): Promise<Blob | null>;
  deletePhotos(ctx: StorageContext, messageIds: number[]): Promise<void>;
  /** Reads the channel oldest first. With `afterMessageId`, only what came after that message. */
  scanLibrary(ctx: StorageContext, options?: { afterMessageId?: number }): AsyncIterable<ScannedPhoto>;

  /** The synced state, or null if none exists. Also null with `changed: false` when `known` is still current. */
  readState(ctx: StorageContext, known: StateVersion | null): Promise<{ changed: false } | { changed: true; file: StateFile | null }>;
  writeState(ctx: StorageContext, bytes: Uint8Array, known: StateVersion | null): Promise<StateVersion>;

  /** Ends the Telegram session on Telegram's side. */
  revokeSession(session: string): Promise<void>;
  close(): Promise<void>;
}

/** A failure with a message written for the person using the app. */
export class UserFacingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'UserFacingError';
  }
}

export class OriginalMissingError extends UserFacingError {
  constructor() {
    super('ORIGINAL_MISSING', 'The original of this photo is no longer in your Telegram library.', 404);
  }
}

/** The Telegram session no longer works, and the user has to sign in again. */
export class SessionRevokedError extends Error {
  constructor(public readonly rpcError: string) {
    super(`Telegram session is no longer valid (${rpcError})`);
    this.name = 'SessionRevokedError';
  }
}

/** Telegram asked us to slow down. Waiting is not a failure, so it costs no retry attempt. */
export class RateLimitedError extends Error {
  constructor(public readonly seconds: number) {
    super(`Telegram asked us to wait ${seconds}s`);
    this.name = 'RateLimitedError';
  }
}
