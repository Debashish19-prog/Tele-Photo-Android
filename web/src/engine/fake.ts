import { realBlob } from './media';
import {
  type CodeResult,
  type EnsureLibraryResult,
  type LoginSuccess,
  OriginalMissingError,
  type PutPhotoInput,
  type ScannedPhoto,
  type StateFile,
  type StateVersion,
  type StorageBackend,
  type StorageContext,
  UserFacingError,
} from './types';

export const FAKE_CODE = '12345';
export const FAKE_PASSWORD = 'hunter2';
const READ_CHUNK_BYTES = 512 * 1024;

interface StoredMessage extends ScannedPhoto {
  file: Blob;
  thumb: Blob | null;
}

/** Where the pretend Telegram keeps things. In demo mode that is the browser, and in tests just memory. */
export interface FakeDisk {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export function memoryDisk(): FakeDisk {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key, value) => void data.set(key, value),
    delete: async (key) => void data.delete(key),
    keys: async () => [...data.keys()],
  };
}

/** A separate database from the app's own, so signing out does not wipe the pretend Telegram too. */
export function browserDisk(name = 'tele-photo-fake-telegram'): FakeDisk {
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async <T>(mode: IDBTransactionMode, work: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const tx = (await db).transaction('kv', mode);
    const req = work(tx.objectStore('kv'));
    return new Promise<T>((resolve, reject) => {
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    get: <T>(key: string) => run('readonly', (os) => os.get(key) as IDBRequest<T | undefined>),
    put: async (key, value) => void (await run('readwrite', (os) => os.put(value, key))),
    delete: async (key) => void (await run('readwrite', (os) => os.delete(key))),
    keys: async () => (await run('readonly', (os) => os.getAllKeys())).map(String),
  };
}

/**
 * Stands in for Telegram during development and tests, and keeps files in this browser.
 * Nothing stored here is backed up anywhere, which is why the UI shows a banner in this mode.
 * A phone number ending in 2 behaves like an account with two-step verification turned on.
 */
export class FakeStorage implements StorageBackend {
  readonly kind = 'fake' as const;
  private readonly logins = new Map<string, { phone: string; awaitingPassword: boolean }>();

  /** Tests set these to rehearse failures. */
  failNextPut: Error | null = null;
  failNextDelete: Error | null = null;
  failReads: Error | null = null;
  putDelayMs = 0;
  /** Test hook that receives the arguments of every stored photo. */
  onPut: ((input: PutPhotoInput) => void) | null = null;
  fetchCount = 0;
  rangeFetchCount = 0;
  thumbFetchCount = 0;
  stateWrites = 0;

  constructor(private readonly disk: FakeDisk = browserDisk()) {}

  private prefix(session: string): string {
    return `${encodeURIComponent(session)}/`;
  }

  private messageKey(session: string, id: number): string {
    return `${this.prefix(session)}m/${String(id).padStart(12, '0')}`;
  }

  private async messageIds(session: string): Promise<number[]> {
    const start = `${this.prefix(session)}m/`;
    return (await this.disk.keys())
      .filter((k) => k.startsWith(start))
      .map((k) => Number.parseInt(k.slice(start.length), 10))
      .sort((a, b) => a - b);
  }

  async sendLoginCode(phone: string): Promise<{ loginId: string; delivery: 'app' | 'other' }> {
    const loginId = crypto.randomUUID();
    this.logins.set(loginId, { phone, awaitingPassword: false });
    return { loginId, delivery: 'app' };
  }

  private success(phone: string): LoginSuccess {
    return {
      status: 'ok',
      session: `fake:${phone}`,
      user: { id: phone.replace(/\D/g, ''), firstName: 'Demo', lastName: 'User', username: 'demo', phone },
    };
  }

  async submitLoginCode(loginId: string, code: string): Promise<CodeResult> {
    const login = this.logins.get(loginId);
    if (!login) throw new UserFacingError('LOGIN_EXPIRED', 'This sign-in has expired. Start again to get a new code.');
    if (code !== FAKE_CODE) throw new UserFacingError('CODE_INVALID', 'That code is not correct.');
    if (login.phone.endsWith('2')) {
      login.awaitingPassword = true;
      return { status: 'needs-password', hint: 'demo hint' };
    }
    this.logins.delete(loginId);
    return this.success(login.phone);
  }

  async submitLoginPassword(loginId: string, password: string): Promise<LoginSuccess> {
    const login = this.logins.get(loginId);
    if (!login?.awaitingPassword) throw new UserFacingError('LOGIN_EXPIRED', 'This sign-in has expired. Start again to get a new code.');
    if (password !== FAKE_PASSWORD) throw new UserFacingError('PASSWORD_INVALID', 'That password is not correct.');
    this.logins.delete(loginId);
    return this.success(login.phone);
  }

  async ensureLibrary(session: string): Promise<EnsureLibraryResult> {
    const existing = (await this.messageIds(session)).length > 0 || (await this.disk.get(`${this.prefix(session)}state`)) !== undefined;
    return { library: { channelId: encodeURIComponent(session), accessHash: '0' }, existing };
  }

  async putPhoto(ctx: StorageContext, input: PutPhotoInput, onProgress: (fraction: number) => void): Promise<{ messageId: number }> {
    this.onPut?.(input);
    if (this.failNextPut) {
      const err = this.failNextPut;
      this.failNextPut = null;
      throw err;
    }
    const steps = this.putDelayMs > 0 ? 10 : 1;
    for (let i = 1; i <= steps; i++) {
      if (this.putDelayMs > 0) await new Promise((r) => setTimeout(r, this.putDelayMs / steps));
      onProgress(i / steps);
    }
    const counter = `${this.prefix(ctx.session)}next`;
    const messageId = ((await this.disk.get<number>(counter)) ?? 0) + 1;
    await this.disk.put(counter, messageId);
    const stored: StoredMessage = {
      messageId, filename: input.filename, size: input.size, mime: input.mime, caption: input.caption,
      // As Telegram would, it takes the bytes now. Saving a video still on the phone as it is would save an empty file.
      date: Math.floor(Date.now() / 1000), hasThumb: input.thumb !== null, file: await realBlob(input.file), thumb: input.thumb,
    };
    await this.disk.put(this.messageKey(ctx.session, messageId), stored);
    return { messageId };
  }

  async getPhoto(ctx: StorageContext, messageId: number): Promise<{ size: number; stream: AsyncIterable<Uint8Array> }> {
    this.fetchCount++;
    if (this.failReads) throw this.failReads;
    const stored = await this.disk.get<StoredMessage>(this.messageKey(ctx.session, messageId));
    if (!stored) throw new OriginalMissingError();
    const { file } = stored;
    async function* chunks(): AsyncIterable<Uint8Array> {
      for (let at = 0; at < file.size; at += READ_CHUNK_BYTES) {
        yield new Uint8Array(await file.slice(at, at + READ_CHUNK_BYTES).arrayBuffer());
      }
    }
    return { size: file.size, stream: chunks() };
  }

  async getPhotoRange(ctx: StorageContext, messageId: number, start: number, end: number): Promise<Uint8Array> {
    this.rangeFetchCount++;
    if (this.failReads) throw this.failReads;
    const stored = await this.disk.get<StoredMessage>(this.messageKey(ctx.session, messageId));
    if (!stored) throw new OriginalMissingError();
    return new Uint8Array(await stored.file.slice(start, end).arrayBuffer());
  }

  async getThumb(ctx: StorageContext, messageId: number): Promise<Blob | null> {
    this.thumbFetchCount++;
    if (this.failReads) throw this.failReads;
    return (await this.disk.get<StoredMessage>(this.messageKey(ctx.session, messageId)))?.thumb ?? null;
  }

  async deletePhotos(ctx: StorageContext, messageIds: number[]): Promise<void> {
    if (this.failNextDelete) {
      const err = this.failNextDelete;
      this.failNextDelete = null;
      throw err;
    }
    for (const id of messageIds) await this.disk.delete(this.messageKey(ctx.session, id));
  }

  async *scanLibrary(ctx: StorageContext, options: { afterMessageId?: number } = {}): AsyncIterable<ScannedPhoto> {
    if (this.failReads) throw this.failReads;
    for (const id of await this.messageIds(ctx.session)) {
      if (id <= (options.afterMessageId ?? 0)) continue;
      const stored = await this.disk.get<StoredMessage>(this.messageKey(ctx.session, id));
      if (!stored) continue;
      const { file: _file, thumb: _thumb, ...scanned } = stored;
      yield scanned;
    }
  }

  async readState(ctx: StorageContext, known: StateVersion | null): Promise<{ changed: false } | { changed: true; file: StateFile | null }> {
    if (this.failReads) throw this.failReads;
    const file = await this.disk.get<StateFile>(`${this.prefix(ctx.session)}state`);
    if (!file) return { changed: true, file: null };
    if (known && known.messageId === file.messageId && known.version === file.version) return { changed: false };
    return { changed: true, file };
  }

  async writeState(ctx: StorageContext, bytes: Uint8Array, known: StateVersion | null): Promise<StateVersion> {
    this.stateWrites++;
    const version = (known?.version ?? 0) + 1;
    const key = `${this.prefix(ctx.session)}state`;
    const current = await this.disk.get<StateFile>(key);
    const file: StateFile = { messageId: 1, version: Math.max(version, (current?.version ?? 0) + 1), bytes };
    await this.disk.put(key, file);
    return { messageId: file.messageId, version: file.version };
  }

  async revokeSession(): Promise<void> {}

  async close(): Promise<void> {}

  /** Lets a test put a message in the channel, as if from another device or by hand. */
  async inject(session: string, message: Omit<StoredMessage, 'messageId' | 'date'>): Promise<number> {
    const counter = `${this.prefix(session)}next`;
    const messageId = ((await this.disk.get<number>(counter)) ?? 0) + 1;
    await this.disk.put(counter, messageId);
    await this.disk.put(this.messageKey(session, messageId), { ...message, messageId, date: Math.floor(Date.now() / 1000) });
    return messageId;
  }

  /** Lets a test confirm nothing is left behind after a permanent delete. */
  async storedCount(session: string): Promise<number> {
    return (await this.messageIds(session)).length;
  }
}
