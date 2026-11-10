import bigInt from 'big-integer';
import { Api, TelegramClient, errors } from 'telegram';
import { LogLevel, Logger } from 'telegram/extensions/Logger.js';
import { generateRandomBytes, readBigIntFromBuffer, sleep } from 'telegram/Helpers.js';
import { computeCheck } from 'telegram/Password.js';
import { StringSession } from 'telegram/sessions/index.js';
import { getAppropriatedPartSize } from 'telegram/Utils.js';
import { STATE_CAPTION, STATE_MARKER, STATE_SEARCH } from './caption';
import {
  type CodeResult,
  type EnsureLibraryResult,
  type LibraryRef,
  type LoginSuccess,
  OriginalMissingError,
  type PutPhotoInput,
  RateLimitedError,
  type ScannedPhoto,
  SessionRevokedError,
  type StateFile,
  type StateVersion,
  type StorageBackend,
  type StorageContext,
  type TelegramUser,
  UserFacingError,
} from './types';

export const LIBRARY_TITLE = 'Tele-Photo Library';
const LIBRARY_MARKER = 'tele-photo-library:v1';
const LIBRARY_ABOUT = `Private storage for your Tele-Photo library. Deleting this channel deletes your photos. ${LIBRARY_MARKER}`;

/** Telegram's largest part size, and also the largest read it allows in one request. */
const DOWNLOAD_REQUEST_BYTES = 512 * 1024;
const UPLOAD_WORKERS = 4;
const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024;
const DISCONNECT_SLEEP_MS = 1000;
/** No answer after this long means none is coming. A request is at most 512 KB, so even a poor connection manages. */
const STALL_MS = 3 * 60 * 1000;
const LOGIN_TTL_MS = 10 * 60 * 1000;
const DELETE_BATCH = 100;
const DIALOG_SCAN_LIMIT = 1000;
/** How many messages one getMessages call can ask for, which a screen of thumbnails makes good use of. */
const MEDIA_LOOKUP_BATCH = 100;
const MEDIA_LOOKUP_WAIT_MS = 15;

const REVOKED_ERRORS = new Set([
  'AUTH_KEY_UNREGISTERED', 'AUTH_KEY_INVALID', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'USER_DEACTIVATED',
  'USER_DEACTIVATED_BAN', 'AUTH_KEY_PERM_EMPTY', 'AUTH_KEY_DUPLICATED',
]);
const STALE_REFERENCE_ERRORS = new Set(['FILE_REFERENCE_EXPIRED', 'FILE_REFERENCE_INVALID']);

export type ClientFactory = (session: string, apiId: number, apiHash: string) => TelegramClient;

const defaultClientFactory: ClientFactory = (session, apiId, apiHash) =>
  new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
    // Over HTTPS even when the page is not, because browsers refuse plain sockets from secure pages.
    useWSS: true,
    // These are what the person sees under Devices in Telegram, so they should recognise them.
    deviceModel: 'Tele-Photo',
    systemVersion: 'Web',
    // Telegram treats a version of "0" as missing and refuses the connection.
    appVersion: '1.0.0',
    baseLogger: new Logger(LogLevel.NONE),
  });

function rpcCode(err: unknown): string | undefined {
  const message = (err as { errorMessage?: unknown } | null)?.errorMessage;
  return typeof message === 'string' ? message : undefined;
}

/** Converts library errors into ones the upload queue and the app know how to handle. */
function translate(err: unknown): unknown {
  if (err instanceof errors.FloodWaitError) return new RateLimitedError(err.seconds);
  const code = rpcCode(err);
  if (code && REVOKED_ERRORS.has(code)) return new SessionRevokedError(code);
  return err;
}

async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw translate(err);
  }
}

/** Telegram has gone quiet. A dropped connection can otherwise leave a request waiting for ever. */
export class StalledError extends Error {
  constructor() {
    super('Telegram stopped responding.');
    this.name = 'StalledError';
  }
}

function loginError(err: unknown): unknown {
  if (err instanceof errors.FloodWaitError) {
    const minutes = Math.ceil(err.seconds / 60);
    return new UserFacingError('TOO_MANY_ATTEMPTS', `Telegram asked us to wait about ${minutes} minute(s) before trying again.`, 429);
  }
  const friendly: Record<string, [string, string]> = {
    PHONE_NUMBER_INVALID: ['PHONE_INVALID', 'That phone number does not look right. Include the country code, like +1 555 123 4567.'],
    PHONE_NUMBER_BANNED: ['PHONE_BANNED', 'Telegram has banned this phone number.'],
    PHONE_NUMBER_FLOOD: ['TOO_MANY_ATTEMPTS', 'Too many codes were requested for this number. Try again later.'],
    PHONE_CODE_INVALID: ['CODE_INVALID', 'That code is not correct.'],
    PHONE_CODE_EMPTY: ['CODE_INVALID', 'Enter the code Telegram sent you.'],
    PHONE_CODE_EXPIRED: ['CODE_EXPIRED', 'That code has expired. Start again to get a new one.'],
    PASSWORD_HASH_INVALID: ['PASSWORD_INVALID', 'That password is not correct.'],
    API_ID_INVALID: ['API_INVALID', 'Telegram rejected VITE_TELEGRAM_API_ID or VITE_TELEGRAM_API_HASH. Check the values this site was built with.'],
    API_ID_PUBLISHED_FLOOD: ['API_INVALID', 'Telegram rejected this API ID. Create your own at my.telegram.org.'],
  };
  const code = rpcCode(err);
  const match = code ? friendly[code] : undefined;
  return match ? new UserFacingError(match[0], match[1]) : err;
}

interface PendingLogin {
  client: TelegramClient;
  phone: string;
  phoneCodeHash: string;
  timer: ReturnType<typeof setTimeout>;
}

type DocumentMedia = Api.MessageMediaDocument & { document: Api.Document };

function isDocumentMedia(media: unknown): media is DocumentMedia {
  return media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document;
}

/** Telegram's own thumbnail types, largest first. A "stripped" one is a 40 px blur, so it does not count. */
function bestThumbType(document: Api.Document): string | null {
  const area = (t: Api.TypePhotoSize) => ('w' in t && 'h' in t ? t.w * t.h : 0);
  const usable = (document.thumbs ?? []).filter(
    (t): t is Api.PhotoSize | Api.PhotoSizeProgressive | Api.PhotoCachedSize =>
      t instanceof Api.PhotoSize || t instanceof Api.PhotoSizeProgressive || t instanceof Api.PhotoCachedSize,
  );
  const [best] = usable.sort((a, b) => area(b) - area(a));
  return best?.type ?? null;
}

/**
 * Each saved copy is a new file with a new id. An edit date would not do, as it only has
 * one-second precision and two devices can easily save within the same second.
 */
function stateVersion(message: Api.Message): number {
  const media = message.media;
  if (!isDocumentMedia(media)) throw new Error('The saved state has no file');
  return media.document.id.mod(bigInt(2).pow(52)).toJSNumber();
}

export class TelegramStorage implements StorageBackend {
  readonly kind = 'telegram' as const;
  private readonly clients = new Map<string, Promise<TelegramClient>>();
  private readonly logins = new Map<string, PendingLogin>();
  /** File references last for hours, so a scroll through the library need not ask for them twice. */
  private readonly mediaCache = new Map<number, DocumentMedia | null>();
  private lookupQueue: { messageId: number; resolve: (media: DocumentMedia | null) => void; reject: (err: unknown) => void }[] = [];
  private lookupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly apiId: number,
    private readonly apiHash: string,
    private readonly createClient: ClientFactory = defaultClientFactory,
    private readonly stallMs = STALL_MS,
  ) {}

  // ---- connections ---------------------------------------------------------------------------

  private client(session: string): Promise<TelegramClient> {
    let pending = this.clients.get(session);
    if (!pending) {
      pending = (async () => {
        const client = this.createClient(session, this.apiId, this.apiHash);
        await client.connect();
        return client;
      })();
      pending.catch(() => this.clients.delete(session));
      this.clients.set(session, pending);
    }
    return pending.then(async (client) => {
      if (!client.connected) await client.connect();
      return client;
    });
  }

  private async release(session: string): Promise<void> {
    const pending = this.clients.get(session);
    this.clients.delete(session);
    if (pending) await pending.then((c) => c.destroy()).catch(() => undefined);
  }

  /**
   * Gives up on a request that has gone quiet. Its connection goes too, as that is usually what
   * failed, and the next request starts a new one.
   */
  private async answered<T>(session: string, work: Promise<T>): Promise<T> {
    const connection = this.clients.get(session);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Another request may have replaced this connection by now, and the new one is fine.
        if (this.clients.get(session) === connection) void this.release(session);
        reject(new StalledError());
      }, this.stallMs);
    });
    try {
      return await Promise.race([work, stalled]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** For a request small enough that the whole of it should finish within the limit. */
  private request<T>(session: string, work: () => Promise<T>): Promise<T> {
    return guard(() => this.answered(session, work()));
  }

  async close(): Promise<void> {
    for (const loginId of [...this.logins.keys()]) await this.dropLogin(loginId);
    await Promise.all([...this.clients.keys()].map((s) => this.release(s)));
  }

  // ---- signing in ----------------------------------------------------------------------------

  private async dropLogin(loginId: string): Promise<void> {
    const login = this.logins.get(loginId);
    if (!login) return;
    this.logins.delete(loginId);
    clearTimeout(login.timer);
    await login.client.destroy().catch(() => undefined);
  }

  private requireLogin(loginId: string): PendingLogin {
    const login = this.logins.get(loginId);
    if (!login) throw new UserFacingError('LOGIN_EXPIRED', 'This sign-in has expired. Start again to get a new code.');
    return login;
  }

  async sendLoginCode(phone: string): Promise<{ loginId: string; delivery: 'app' | 'other' }> {
    const client = this.createClient('', this.apiId, this.apiHash);
    try {
      await client.connect();
      const { phoneCodeHash, isCodeViaApp } = await client.sendCode({ apiId: this.apiId, apiHash: this.apiHash }, phone);
      const loginId = crypto.randomUUID();
      const timer = setTimeout(() => void this.dropLogin(loginId), LOGIN_TTL_MS);
      this.logins.set(loginId, { client, phone, phoneCodeHash, timer });
      return { loginId, delivery: isCodeViaApp ? 'app' : 'other' };
    } catch (err) {
      await client.destroy().catch(() => undefined);
      throw loginError(err);
    }
  }

  private async finishLogin(loginId: string, login: PendingLogin, user: Api.TypeUser): Promise<LoginSuccess> {
    if (!(user instanceof Api.User)) throw new Error('Telegram returned an empty user');
    const session = (login.client.session as StringSession).save();
    const info: TelegramUser = {
      id: user.id.toString(),
      firstName: user.firstName ?? '',
      lastName: user.lastName ?? '',
      username: user.username ?? '',
      phone: user.phone ? `+${user.phone}` : login.phone,
    };
    await this.dropLogin(loginId);
    return { status: 'ok', session, user: info };
  }

  async submitLoginCode(loginId: string, code: string): Promise<CodeResult> {
    const login = this.requireLogin(loginId);
    try {
      const result = await login.client.invoke(
        new Api.auth.SignIn({ phoneNumber: login.phone, phoneCodeHash: login.phoneCodeHash, phoneCode: code }),
      );
      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        await this.dropLogin(loginId);
        throw new UserFacingError('NO_ACCOUNT', 'There is no Telegram account for this number. Create one in the Telegram app first.');
      }
      return await this.finishLogin(loginId, login, result.user);
    } catch (err) {
      if (rpcCode(err) === 'SESSION_PASSWORD_NEEDED') {
        const password = await login.client.invoke(new Api.account.GetPassword());
        return { status: 'needs-password', hint: password.hint ?? '' };
      }
      if (rpcCode(err) === 'PHONE_CODE_EXPIRED') await this.dropLogin(loginId);
      throw loginError(err);
    }
  }

  async submitLoginPassword(loginId: string, password: string): Promise<LoginSuccess> {
    const login = this.requireLogin(loginId);
    try {
      const srp = await login.client.invoke(new Api.account.GetPassword());
      const check = await computeCheck(srp, password);
      const result = await login.client.invoke(new Api.auth.CheckPassword({ password: check }));
      if (result instanceof Api.auth.AuthorizationSignUpRequired) throw new Error('Unexpected sign-up request after 2FA');
      return await this.finishLogin(loginId, login, result.user);
    } catch (err) {
      throw loginError(err);
    }
  }

  async revokeSession(session: string): Promise<void> {
    const client = await this.client(session);
    try {
      await client.invoke(new Api.auth.LogOut());
    } finally {
      await this.release(session);
    }
  }

  // ---- the library channel -------------------------------------------------------------------

  private peer(ref: LibraryRef): Api.InputPeerChannel {
    return new Api.InputPeerChannel({ channelId: bigInt(ref.channelId), accessHash: bigInt(ref.accessHash) });
  }

  private inputChannel(ref: LibraryRef): Api.InputChannel {
    return new Api.InputChannel({ channelId: bigInt(ref.channelId), accessHash: bigInt(ref.accessHash) });
  }

  /**
   * A private channel rather than Saved Messages: it keeps the library out of the way, cannot be
   * cleared by accident while tidying up personal notes, and holds nothing but photos.
   */
  async ensureLibrary(session: string): Promise<EnsureLibraryResult> {
    return guard(async () => {
      const client = await this.client(session);

      // Found by marker so a new device reconnects to the old library rather than starting another.
      for await (const dialog of client.iterDialogs({ limit: DIALOG_SCAN_LIMIT })) {
        const entity = dialog.entity;
        if (!(entity instanceof Api.Channel) || !entity.creator || entity.title !== LIBRARY_TITLE || !entity.accessHash) continue;
        const full = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
        if (full.fullChat.about.includes(LIBRARY_MARKER)) {
          return { library: { channelId: entity.id.toString(), accessHash: entity.accessHash.toString() }, existing: true };
        }
      }

      const created = await client.invoke(
        new Api.channels.CreateChannel({ title: LIBRARY_TITLE, about: LIBRARY_ABOUT, broadcast: true }),
      );
      const channel = 'chats' in created ? created.chats.find((c) => c instanceof Api.Channel) : undefined;
      if (!(channel instanceof Api.Channel) || !channel.accessHash) throw new Error('Telegram did not return the new channel');
      return { library: { channelId: channel.id.toString(), accessHash: channel.accessHash.toString() }, existing: false };
    });
  }

  // ---- storing -------------------------------------------------------------------------------

  /**
   * Sends a file a part at a time, reading each part only when it is about to go.
   *
   * This deliberately does not use `client.uploadFile`. Given a browser File, that method reads the
   * whole thing into one buffer first, which would run a phone out of memory on a large photo.
   */
  private async uploadBlob(
    session: string,
    client: TelegramClient,
    file: Blob,
    name: string,
    onProgress: (fraction: number) => void = () => undefined,
  ): Promise<Api.InputFile | Api.InputFileBig> {
    const size = file.size;
    const fileId = readBigIntFromBuffer(generateRandomBytes(8), true, true);
    const isLarge = size > LARGE_FILE_THRESHOLD;
    const partSize = getAppropriatedPartSize(bigInt(size)) * 1024;
    const partCount = Math.ceil(size / partSize);

    let nextPart = 0;
    let sent = 0;
    /** Set once any part has failed, so the others stop rather than carry on with no purpose. */
    let abandoned = false;
    onProgress(0);

    const sendPart = async (part: number) => {
      const bytes = Buffer.from(await file.slice(part * partSize, (part + 1) * partSize).arrayBuffer());
      while (!abandoned) {
        // Uploads always go to the account's home data centre, and a reconnect can replace the sender.
        const sender = await this.answered(session, client.getSender(client.session.dcId));
        try {
          await this.answered(
            session,
            Promise.resolve(
              sender.send(
                isLarge
                  ? new Api.upload.SaveBigFilePart({ fileId, filePart: part, fileTotalParts: partCount, bytes })
                  : new Api.upload.SaveFilePart({ fileId, filePart: part, bytes }),
              ),
            ),
          );
          return;
        } catch (err) {
          if (err instanceof StalledError) throw err;
          if (!sender.isConnected()) {
            await sleep(DISCONNECT_SLEEP_MS);
            continue;
          }
          if (err instanceof errors.FloodWaitError) {
            await sleep(err.seconds * 1000);
            continue;
          }
          throw err;
        }
      }
    };

    const worker = async () => {
      try {
        while (!abandoned && nextPart < partCount) {
          await sendPart(nextPart++);
          if (abandoned) return;
          sent++;
          onProgress(sent / partCount);
        }
      } catch (err) {
        abandoned = true;
        throw err;
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_WORKERS, partCount) }, worker));

    return isLarge
      ? new Api.InputFileBig({ id: fileId, parts: partCount, name })
      : new Api.InputFile({ id: fileId, parts: partCount, name, md5Checksum: '' });
  }

  /**
   * Sends one file as one message, as a document, and confirms what Telegram kept.
   *
   * This deliberately does not use `client.sendFile`. For .jpg, .jpeg and .png files that method
   * computes `forceFile: forceDocument && !isImage`, so it clears force_file on exactly the files
   * we care about even when asked to send a document. Building the request ourselves is the only
   * way to be sure the flag is set.
   */
  async putPhoto(ctx: StorageContext, input: PutPhotoInput, onProgress: (fraction: number) => void): Promise<{ messageId: number }> {
    return guard(async () => {
      const client = await this.answered(ctx.session, this.client(ctx.session));
      const peer = this.peer(ctx.library);
      const file = await this.uploadBlob(ctx.session, client, input.file, input.filename, onProgress);
      const thumb = input.thumb ? await this.uploadBlob(ctx.session, client, input.thumb, 'thumb.jpg') : undefined;

      const send = async (withThumb: Api.InputFile | Api.InputFileBig | undefined) => {
        const randomId = readBigIntFromBuffer(generateRandomBytes(8), true, true);
        const result = await client.invoke(
          new Api.messages.SendMedia({
            peer,
            media: new Api.InputMediaUploadedDocument({
              file,
              thumb: withThumb,
              forceFile: true,
              mimeType: input.mime,
              attributes: [new Api.DocumentAttributeFilename({ fileName: input.filename })],
            }),
            message: input.caption,
            randomId,
            silent: true,
          }),
        );
        return this.sentMessage(client, peer, result, randomId);
      };

      let message: Api.Message;
      try {
        message = await this.answered(ctx.session, send(thumb));
      } catch (err) {
        // The photo matters and its thumbnail does not, so a refused thumbnail must not lose the upload.
        const code = rpcCode(err);
        if (!thumb || !code?.includes('THUMB')) throw err;
        message = await this.answered(ctx.session, send(undefined));
      }

      const media = message.media;
      const intact = isDocumentMedia(media) && media.document.size.toString() === String(input.size);
      if (!intact) {
        // Never accept a copy that differs from what we sent. The original is still on disk, so this retries safely.
        await this.answered(ctx.session, client.invoke(new Api.channels.DeleteMessages({ channel: this.inputChannel(ctx.library), id: [message.id] }))).catch(() => undefined);
        throw new Error('Telegram did not store this file as an unmodified document');
      }
      this.mediaCache.set(message.id, media);
      return { messageId: message.id };
    });
  }

  private async sentMessage(
    client: TelegramClient,
    peer: Api.InputPeerChannel,
    result: Api.TypeUpdates,
    randomId: bigInt.BigInteger,
  ): Promise<Api.Message> {
    const updates = result instanceof Api.Updates || result instanceof Api.UpdatesCombined ? result.updates : [];
    const idUpdate = updates.find((u) => u instanceof Api.UpdateMessageID && u.randomId?.equals(randomId));
    const messageId = idUpdate instanceof Api.UpdateMessageID ? idUpdate.id : undefined;

    for (const update of updates) {
      if (
        update instanceof Api.UpdateNewChannelMessage &&
        update.message instanceof Api.Message &&
        (messageId === undefined || update.message.id === messageId)
      ) {
        return update.message;
      }
    }
    if (messageId !== undefined) {
      const [fetched] = await client.getMessages(peer, { ids: [messageId] });
      if (fetched instanceof Api.Message) return fetched;
    }
    throw new Error('Telegram did not confirm the sent message');
  }

  // ---- reading -------------------------------------------------------------------------------

  private async readableMessage(client: TelegramClient, ctx: StorageContext, messageId: number) {
    // Always fetched fresh: file references expire, so a stored one cannot be relied on.
    const [message] = await client.getMessages(this.peer(ctx.library), { ids: [messageId] });
    if (!(message instanceof Api.Message) || !isDocumentMedia(message.media)) throw new OriginalMissingError();
    return { media: message.media, document: message.media.document };
  }

  async getPhoto(ctx: StorageContext, messageId: number): Promise<{ size: number; stream: AsyncIterable<Uint8Array> }> {
    return guard(async () => {
      const client = await this.client(ctx.session);
      const { media, document } = await this.readableMessage(client, ctx, messageId);
      // `iterDownload` must receive the media object. Passing the Message itself throws.
      const stream = client.iterDownload({ file: media, requestSize: DOWNLOAD_REQUEST_BYTES });
      return { size: document.size.toJSNumber(), stream: stream as AsyncIterable<Uint8Array> };
    });
  }

  /** Telegram only serves whole blocks from aligned offsets, so this fetches those and trims the ends. */
  async getPhotoRange(ctx: StorageContext, messageId: number, start: number, end: number): Promise<Uint8Array> {
    // A few blocks at most, so it is timed as a whole. Otherwise a dropped connection leaves the video waiting for ever.
    return this.request(ctx.session, async () => {
      const client = await this.client(ctx.session);
      const first = Math.floor(start / DOWNLOAD_REQUEST_BYTES);
      const last = Math.ceil(end / DOWNLOAD_REQUEST_BYTES);
      const blocks = Array.from({ length: last - first }, (_, i) => first + i);
      for (let attempt = 0; ; attempt++) {
        // Not fetched fresh as `getPhoto` does: a playing video reads constantly, and one extra call per read adds up.
        const media = await this.lookupMedia(client, ctx, messageId);
        if (!media) throw new OriginalMissingError();
        try {
          // Side by side, so high-bitrate video is not limited to one block per round trip.
          const bytes = Buffer.concat(await Promise.all(blocks.map((block) => this.readBlock(client, media, block))));
          const skip = start - first * DOWNLOAD_REQUEST_BYTES;
          return bytes.subarray(skip, skip + (end - start));
        } catch (err) {
          if (attempt > 0 || !STALE_REFERENCE_ERRORS.has(rpcCode(err) ?? '')) throw err;
          this.mediaCache.delete(messageId);
        }
      }
    });
  }

  private async readBlock(client: TelegramClient, media: DocumentMedia, block: number): Promise<Buffer> {
    const stream = client.iterDownload({ file: media, offset: bigInt(block).multiply(DOWNLOAD_REQUEST_BYTES), requestSize: DOWNLOAD_REQUEST_BYTES, limit: 1 });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  /** Requests made within a few milliseconds of each other share one call, as a grid asks for dozens at once. */
  private lookupMedia(client: TelegramClient, ctx: StorageContext, messageId: number): Promise<DocumentMedia | null> {
    const cached = this.mediaCache.get(messageId);
    if (cached !== undefined) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
      this.lookupQueue.push({ messageId, resolve, reject });
      this.scheduleLookup(client, ctx);
    });
  }

  private scheduleLookup(client: TelegramClient, ctx: StorageContext): void {
    this.lookupTimer ??= setTimeout(() => {
      this.lookupTimer = null;
      const batch = this.lookupQueue.splice(0, MEDIA_LOOKUP_BATCH);
      if (this.lookupQueue.length > 0) this.scheduleLookup(client, ctx);
      void client
        .getMessages(this.peer(ctx.library), { ids: batch.map((b) => b.messageId) })
        .then((messages) => {
          const byId = new Map(messages.filter((m) => m instanceof Api.Message).map((m) => [m.id, m]));
          for (const request of batch) {
            const media = byId.get(request.messageId)?.media;
            if (isDocumentMedia(media)) this.mediaCache.set(request.messageId, media);
            request.resolve(isDocumentMedia(media) ? media : null);
          }
        })
        .catch((err) => {
          for (const request of batch) request.reject(err);
        });
    }, MEDIA_LOOKUP_WAIT_MS);
  }

  async getThumb(ctx: StorageContext, messageId: number): Promise<Blob | null> {
    return guard(async () => {
      const client = await this.client(ctx.session);
      for (let attempt = 0; ; attempt++) {
        const media = await this.lookupMedia(client, ctx, messageId);
        if (!media) return null;
        const type = bestThumbType(media.document);
        if (!type) return null;
        try {
          // A type name is what picks a size here. GramJS handles one, though its declared types leave it out.
          const bytes = await client.downloadMedia(media, { thumb: type as unknown as number });
          if (!bytes || bytes.length === 0) return null;
          return new Blob([bytes as BlobPart], { type: 'image/jpeg' });
        } catch (err) {
          if (attempt > 0 || !STALE_REFERENCE_ERRORS.has(rpcCode(err) ?? '')) throw err;
          this.mediaCache.delete(messageId);
        }
      }
    });
  }

  async deletePhotos(ctx: StorageContext, messageIds: number[]): Promise<void> {
    await guard(async () => {
      const client = await this.client(ctx.session);
      const channel = this.inputChannel(ctx.library);
      for (let i = 0; i < messageIds.length; i += DELETE_BATCH) {
        await client.invoke(new Api.channels.DeleteMessages({ channel, id: messageIds.slice(i, i + DELETE_BATCH) }));
      }
      for (const id of messageIds) this.mediaCache.delete(id);
    });
  }

  async *scanLibrary(ctx: StorageContext, options: { afterMessageId?: number } = {}): AsyncIterable<ScannedPhoto> {
    const client = await this.request(ctx.session, () => this.client(ctx.session));
    try {
      const messages = client.iterMessages(this.peer(ctx.library), { reverse: true, minId: options.afterMessageId ?? 0 })[Symbol.asyncIterator]();
      for (;;) {
        // Each step is timed by itself, as reading a large library can rightly take a long while.
        const { value: message, done } = await this.answered(ctx.session, messages.next());
        if (done) return;
        const media = message.media;
        if (!isDocumentMedia(media)) continue;
        // Saves asking for it again when this photo's thumbnail is wanted moments later.
        this.mediaCache.set(message.id, media);
        const nameAttr = media.document.attributes.find((a) => a instanceof Api.DocumentAttributeFilename);
        yield {
          messageId: message.id,
          filename: nameAttr instanceof Api.DocumentAttributeFilename ? nameAttr.fileName : `photo-${message.id}`,
          size: media.document.size.toJSNumber(),
          mime: media.document.mimeType,
          caption: message.message ?? '',
          date: message.date,
          hasThumb: bestThumbType(media.document) !== null,
        };
      }
    } catch (err) {
      throw translate(err);
    }
  }

  // ---- the synced state ----------------------------------------------------------------------

  /** Pinned, so a new device finds it at once rather than after reading the whole channel. */
  private async findStateMessage(client: TelegramClient, ctx: StorageContext): Promise<Api.Message | null> {
    const peer = this.peer(ctx.library);
    const isState = (m: unknown): m is Api.Message & { media: DocumentMedia } =>
      m instanceof Api.Message && isDocumentMedia(m.media) && (m.message ?? '').includes(STATE_MARKER);

    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: this.inputChannel(ctx.library) }));
    const pinnedId = full.fullChat instanceof Api.ChannelFull ? full.fullChat.pinnedMsgId : undefined;
    if (pinnedId) {
      const [pinned] = await client.getMessages(peer, { ids: [pinnedId] });
      if (isState(pinned)) return pinned;
    }
    // Someone may have unpinned it by hand.
    const found = await client.getMessages(peer, { search: STATE_SEARCH, limit: 1 });
    return isState(found[0]) ? found[0] : null;
  }

  async readState(ctx: StorageContext, known: StateVersion | null) {
    return this.request(ctx.session, async (): Promise<{ changed: false } | { changed: true; file: StateFile | null }> => {
      const client = await this.client(ctx.session);
      const message = await this.findStateMessage(client, ctx);
      if (!message) return { changed: true, file: null };
      const version = stateVersion(message);
      if (known && known.messageId === message.id && known.version === version) return { changed: false };
      const bytes = await client.downloadMedia(message.media as DocumentMedia);
      return { changed: true, file: { messageId: message.id, version, bytes: new Uint8Array(bytes as Uint8Array) } };
    });
  }

  /**
   * Replaces the file inside one pinned message, so its id stays put and the channel does not fill
   * up with old copies. A new message and pin are only used when that cannot be done.
   */
  async writeState(ctx: StorageContext, bytes: Uint8Array, known: StateVersion | null): Promise<StateVersion> {
    return this.request(ctx.session, async () => {
      const client = await this.client(ctx.session);
      const peer = this.peer(ctx.library);
      const name = 'tele-photo-state.json.gz';
      const file = await this.uploadBlob(ctx.session, client, new Blob([bytes as BlobPart]), name);
      const media = () =>
        new Api.InputMediaUploadedDocument({
          file,
          forceFile: true,
          mimeType: 'application/gzip',
          attributes: [new Api.DocumentAttributeFilename({ fileName: name })],
        });

      if (known) {
        try {
          const result = await client.invoke(new Api.messages.EditMessage({ peer, id: known.messageId, media: media(), message: STATE_CAPTION }));
          const updates = result instanceof Api.Updates || result instanceof Api.UpdatesCombined ? result.updates : [];
          for (const update of updates) {
            if (update instanceof Api.UpdateEditChannelMessage && update.message instanceof Api.Message && update.message.id === known.messageId) {
              return { messageId: known.messageId, version: stateVersion(update.message) };
            }
          }
          const [fetched] = await client.getMessages(peer, { ids: [known.messageId] });
          if (fetched instanceof Api.Message) return { messageId: known.messageId, version: stateVersion(fetched) };
        } catch (err) {
          if (err instanceof errors.FloodWaitError || REVOKED_ERRORS.has(rpcCode(err) ?? '')) throw err;
          // Deleted, or too old to edit. Falls through to starting a new message below.
        }
      }

      const randomId = readBigIntFromBuffer(generateRandomBytes(8), true, true);
      const result = await client.invoke(new Api.messages.SendMedia({ peer, media: media(), message: STATE_CAPTION, randomId, silent: true }));
      const message = await this.sentMessage(client, peer, result, randomId);
      await client.invoke(new Api.messages.UpdatePinnedMessage({ peer, id: message.id, silent: true }));
      if (known) {
        await client.invoke(new Api.channels.DeleteMessages({ channel: this.inputChannel(ctx.library), id: [known.messageId] })).catch(() => undefined);
      }
      return { messageId: message.id, version: stateVersion(message) };
    });
  }
}
