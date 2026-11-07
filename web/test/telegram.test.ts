/**
 * Runs the real GramJS code down to the point a request would hit the network. Only the socket is
 * replaced, so these tests check the exact requests Telegram would receive.
 */
import bigInt from 'big-integer';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api, TelegramClient, errors } from 'telegram';
import { CustomFile } from 'telegram/client/uploads.js';
import { StringSession } from 'telegram/sessions/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PHOTO_BYTES } from '../src/engine/index';
import { StalledError, TelegramStorage } from '../src/engine/telegram';
import { OriginalMissingError, RateLimitedError, SessionRevokedError, UserFacingError } from '../src/engine/types';

const ctx = { session: '', library: { channelId: '777', accessHash: '888' } };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** What Telegram would answer to a successful SendMedia, unless a test overrides `reply`. */
function documentReply(req: Api.messages.SendMedia, size: number, messageId = 42) {
  return new Api.Updates({
    updates: [
      new Api.UpdateMessageID({ id: messageId, randomId: req.randomId }),
      new Api.UpdateNewChannelMessage({
        pts: 1,
        ptsCount: 1,
        message: new Api.Message({
          id: messageId,
          peerId: new Api.PeerChannel({ channelId: bigInt(777) }),
          date: 1,
          message: req.message,
          media: new Api.MessageMediaDocument({
            document: new Api.Document({
              id: bigInt(1), accessHash: bigInt(2), fileReference: Buffer.alloc(0), date: 1,
              mimeType: 'image/jpeg', size: bigInt(size), dcId: 2, attributes: [],
            }),
          }),
        }),
      }),
    ],
    users: [],
    chats: [],
    date: 1,
    seq: 1,
  });
}

class Harness {
  parts = new Map<number, Buffer>();
  /** Plain facts only. GramJS requests retain their bytes, so keeping them would itself use 2 GB. */
  partRequests: { filePart: number; fileTotalParts: number | null; isBig: boolean }[] = [];
  keepBytes = true;
  sent: Api.messages.SendMedia[] = [];
  deleted: Api.channels.DeleteMessages[] = [];
  reply: ((req: Api.messages.SendMedia) => unknown) | null = null;
  invokeError: unknown = null;
  remote: Buffer = Buffer.alloc(0);
  getFileRequests: Api.upload.GetFile[] = [];
  getMessagesCalls: number[][] = [];
  /** Set by getMessages. A real Api.Message, or anything else to simulate a missing one. */
  messages: unknown[] = [];

  factory = (): TelegramClient => {
    const client = new TelegramClient(new StringSession(''), 1, 'hash', { connectionRetries: 0 });
    const sender = {
      dcId: 2,
      isConnected: () => true,
      send: async (req: Api.upload.SaveBigFilePart | Api.upload.SaveFilePart) => {
        const isBig = req instanceof Api.upload.SaveBigFilePart;
        this.partRequests.push({ filePart: req.filePart, fileTotalParts: isBig ? req.fileTotalParts : null, isBig });
        if (this.keepBytes) this.parts.set(req.filePart, Buffer.from(req.bytes));
        return true;
      },
    };
    Object.defineProperty(client, 'connected', { get: () => true });
    client.connect = async () => true;
    client.destroy = async () => {};
    client.getSender = (async () => sender) as unknown as TelegramClient['getSender'];
    client.invoke = (async (req: unknown) => {
      if (this.invokeError) throw this.invokeError;
      if (req instanceof Api.messages.SendMedia) {
        this.sent.push(req);
        if (this.reply) return this.reply(req);
        const file = (req.media as Api.InputMediaUploadedDocument).file;
        const size = file instanceof Api.InputFileBig || file instanceof Api.InputFile ? [...this.parts.values()].reduce((n, b) => n + b.length, 0) : 0;
        return documentReply(req, size);
      }
      if (req instanceof Api.channels.DeleteMessages) {
        this.deleted.push(req);
        return new Api.messages.AffectedMessages({ pts: 1, ptsCount: 1 });
      }
      throw new Error(`Unexpected request: ${(req as { className?: string }).className}`);
    }) as TelegramClient['invoke'];
    client.invokeWithSender = (async (req: Api.upload.GetFile) => {
      this.getFileRequests.push(req);
      const offset = req.offset.toJSNumber();
      return new Api.upload.File({
        type: new Api.storage.FileUnknown(),
        mtime: 1,
        bytes: this.remote.subarray(offset, offset + req.limit),
      });
    }) as unknown as TelegramClient['invokeWithSender'];
    client.getMessages = (async (_peer: unknown, options: { ids?: number[] } = {}) => {
      this.getMessagesCalls.push(options.ids ?? []);
      return this.messages;
    }) as unknown as TelegramClient['getMessages'];
    return client;
  };

  storage = new TelegramStorage(1, 'hash', this.factory);

  reassembled(): Buffer {
    const order = [...this.parts.keys()].sort((a, b) => a - b);
    return Buffer.concat(order.map((i) => this.parts.get(i)!));
  }
}

function storedMessage(size: number) {
  return new Api.Message({
    id: 42,
    peerId: new Api.PeerChannel({ channelId: bigInt(777) }),
    date: 1,
    message: '',
    media: new Api.MessageMediaDocument({
      document: new Api.Document({
        id: bigInt(1), accessHash: bigInt(2), fileReference: Buffer.from([1]), date: 1,
        mimeType: 'image/jpeg', size: bigInt(size), dcId: 2, attributes: [],
      }),
    }),
  });
}

describe('TelegramStorage against real GramJS', () => {
  let dir: string;
  let h: Harness;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tp-tg-'));
    h = new Harness();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function put(name: string, bytes: Buffer, mime = 'image/jpeg') {
    return h.storage.putPhoto(ctx, { file: new Blob([bytes as BlobPart]), thumb: null, filename: name, mime, size: bytes.length, caption: 'cap' }, () => {});
  }

  it('documents why we avoid sendFile: it clears force_file for JPEGs even with forceDocument', async () => {
    // If a GramJS upgrade ever changes this, the workaround may no longer be needed.
    const path = join(dir, 'a.jpg');
    const bytes = randomBytes(2048);
    writeFileSync(path, bytes);
    const client = h.factory();
    (client as unknown as { getInputEntity: unknown }).getInputEntity = async () => new Api.InputPeerSelf();
    (client as unknown as { _getResponseMessage: unknown })._getResponseMessage = () => new Api.MessageEmpty({ id: 1 });
    await client.sendFile('me', { file: new CustomFile('a.jpg', bytes.length, path), forceDocument: true }).catch(() => {});
    const media = h.sent[0]!.media as Api.InputMediaUploadedDocument;
    expect(media.className).toBe('InputMediaUploadedDocument');
    expect(media.forceFile).toBeFalsy();
  });

  for (const name of ['a.jpg', 'b.JPEG', 'c.png', 'd.gif', 'e.webp', 'f.heic']) {
    it(`sends ${name} as a forced document, never as a compressed photo`, async () => {
      const bytes = randomBytes(5000);
      await put(name, bytes);
      expect(h.sent).toHaveLength(1);
      const req = h.sent[0]!;
      expect(req.media).toBeInstanceOf(Api.InputMediaUploadedDocument);
      const media = req.media as Api.InputMediaUploadedDocument;
      expect(media.forceFile).toBe(true);
      expect(media.mimeType).toBe('image/jpeg');
      expect(media.attributes[0]).toBeInstanceOf(Api.DocumentAttributeFilename);
      expect((media.attributes[0] as Api.DocumentAttributeFilename).fileName).toBe(name);
      // A request that serializes is one Telegram can parse.
      expect(req.getBytes().length).toBeGreaterThan(0);
    });
  }

  it('sends a small file byte for byte, in one message', async () => {
    const bytes = randomBytes(3 * 1024 * 1024 + 17);
    const { messageId } = await put('small.jpg', bytes);
    expect(messageId).toBe(42);
    expect(h.sent).toHaveLength(1);
    expect(sha(h.reassembled())).toBe(sha(bytes));
    expect(h.partRequests[0]!.isBig).toBe(false);
  });

  it('sends a file over 10 MB through the big-file call, byte for byte', async () => {
    const bytes = randomBytes(25 * 1024 * 1024 + 123);
    await put('big.jpg', bytes);
    expect(h.partRequests[0]!.isBig).toBe(true);
    expect(sha(h.reassembled())).toBe(sha(bytes));
    const media = h.sent[0]!.media as Api.InputMediaUploadedDocument;
    expect(media.file).toBeInstanceOf(Api.InputFileBig);
  });

  it('handles the largest allowed file: 4000 parts, one message, bounded memory', async () => {
    h.keepBytes = false;
    // Stands in for a file on disk. Hands out only the part asked for, and records how much was ever held.
    let liveReads = 0;
    let mostLive = 0;
    let readAll = false;
    const huge = {
      size: MAX_PHOTO_BYTES,
      slice: (start: number, end: number) => ({
        arrayBuffer: async () => {
          if (end - start >= MAX_PHOTO_BYTES) readAll = true;
          liveReads++;
          mostLive = Math.max(mostLive, liveReads);
          liveReads--;
          return new ArrayBuffer(end - start);
        },
      }),
    } as unknown as Blob;
    h.reply = (req) => documentReply(req, MAX_PHOTO_BYTES);

    const before = process.memoryUsage().rss;
    let peak = before;
    let last = 0;
    await h.storage.putPhoto(ctx, { file: huge, thumb: null, filename: 'max.jpg', mime: 'image/jpeg', size: MAX_PHOTO_BYTES, caption: '' }, (f) => {
      last = f;
      peak = Math.max(peak, process.memoryUsage().rss);
    });
    expect(readAll).toBe(false);

    expect(h.sent).toHaveLength(1);
    const file = (h.sent[0]!.media as Api.InputMediaUploadedDocument).file as Api.InputFileBig;
    expect(file).toBeInstanceOf(Api.InputFileBig);
    expect(file.parts).toBe(4000);
    expect(h.partRequests).toHaveLength(4000);
    for (const part of h.partRequests) expect(part.fileTotalParts).toBe(4000);
    expect(new Set(h.partRequests.map((p) => p.filePart)).size).toBe(4000);
    expect(last).toBeCloseTo(1, 5);
    // One part at a time. The whole file in memory would be about 2000 MB, and would crash a phone.
    expect(peak - before).toBeLessThan(500 * 1024 * 1024);
  }, 180_000);

  it('attaches the thumbnail to the document, so other devices need not download the photo', async () => {
    const bytes = randomBytes(1000);
    // Real Telegram keeps each file's parts apart by id. This harness does not, so it is told the size.
    h.reply = (req) => documentReply(req, bytes.length);
    await h.storage.putPhoto(ctx, { file: new Blob([bytes as BlobPart]), thumb: new Blob([randomBytes(200)], { type: 'image/jpeg' }), filename: 'a.jpg', mime: 'image/jpeg', size: bytes.length, caption: '' }, () => {});
    const media = h.sent[0]!.media as Api.InputMediaUploadedDocument;
    expect(media.thumb).toBeInstanceOf(Api.InputFile);
    expect(media.forceFile).toBe(true);
    expect(h.sent[0]!.getBytes().length).toBeGreaterThan(0);
  });

  it('sends the photo anyway if Telegram refuses its thumbnail', async () => {
    const bytes = randomBytes(1000);
    let attempts = 0;
    h.reply = (req) => {
      attempts++;
      if ((req.media as Api.InputMediaUploadedDocument).thumb) throw Object.assign(new Error('x'), { errorMessage: 'THUMB_INVALID' });
      return documentReply(req, bytes.length);
    };
    const { messageId } = await h.storage.putPhoto(ctx, { file: new Blob([bytes as BlobPart]), thumb: new Blob([randomBytes(200)]), filename: 'a.jpg', mime: 'image/jpeg', size: bytes.length, caption: '' }, () => {});
    expect(messageId).toBe(42);
    expect(attempts).toBe(2);
  });

  it('does not hide other failures behind a retry without the thumbnail', async () => {
    let attempts = 0;
    h.reply = () => {
      attempts++;
      throw Object.assign(new Error('x'), { errorMessage: 'CHANNEL_PRIVATE' });
    };
    await expect(h.storage.putPhoto(ctx, { file: new Blob([randomBytes(10)]), thumb: new Blob([randomBytes(20)]), filename: 'a.jpg', mime: 'image/jpeg', size: 10, caption: '' }, () => {})).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it('reports progress all the way to the end, whatever order parts finish in', async () => {
    const bytes = randomBytes(2 * 1024 * 1024);
    const seen: number[] = [];
    await h.storage.putPhoto(ctx, { file: new Blob([bytes as BlobPart]), thumb: null, filename: 'a.jpg', mime: 'image/jpeg', size: bytes.length, caption: '' }, (f) => seen.push(f));
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('rejects the upload and removes the message if Telegram returned a compressed photo', async () => {
    h.reply = (req) =>
      new Api.Updates({
        updates: [
          new Api.UpdateMessageID({ id: 9, randomId: req.randomId }),
          new Api.UpdateNewChannelMessage({
            pts: 1, ptsCount: 1,
            message: new Api.Message({
              id: 9, peerId: new Api.PeerChannel({ channelId: bigInt(777) }), date: 1, message: '',
              media: new Api.MessageMediaPhoto({}),
            }),
          }),
        ],
        users: [], chats: [], date: 1, seq: 1,
      });
    await expect(put('a.jpg', randomBytes(1000))).rejects.toThrow(/unmodified document/);
    expect(h.deleted[0]!.id).toEqual([9]);
  });

  it('rejects the upload if Telegram kept a different size', async () => {
    h.reply = (req) => documentReply(req, 999);
    await expect(put('a.jpg', randomBytes(1000))).rejects.toThrow(/unmodified document/);
    expect(h.deleted).toHaveLength(1);
  });

  it('turns a flood wait into a queue pause rather than a failure', async () => {
    h.invokeError = new errors.FloodWaitError({ request: new Api.help.GetConfig(), capture: 120 } as never);
    await expect(put('a.jpg', randomBytes(100))).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('recognises a session the user ended from their Telegram settings', async () => {
    h.invokeError = Object.assign(new Error('x'), { errorMessage: 'AUTH_KEY_UNREGISTERED' });
    await expect(put('a.jpg', randomBytes(100))).rejects.toBeInstanceOf(SessionRevokedError);
  });

  for (const [label, size] of [
    ['smaller than one request', 1000],
    ['exactly one request', 512 * 1024],
    ['exactly two requests', 1024 * 1024],
    ['one byte past two requests', 1024 * 1024 + 1],
    ['several requests', 3 * 1024 * 1024 + 4242],
  ] as const) {
    it(`downloads a file ${label} byte for byte, with valid offsets`, async () => {
      h.remote = randomBytes(size);
      h.messages = [storedMessage(size)];
      const { size: reported, stream } = await h.storage.getPhoto(ctx, 42);
      expect(reported).toBe(size);
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(sha(Buffer.concat(chunks))).toBe(sha(h.remote));
      for (const req of h.getFileRequests) {
        // Telegram's documented rules for upload.getFile without the `precise` flag.
        expect(req.limit % 4096).toBe(0);
        expect((1024 * 1024) % req.limit).toBe(0);
        expect(req.offset.toJSNumber() % 4096).toBe(0);
      }
    });
  }

  it('reports a clear error when the message is gone from Telegram', async () => {
    h.messages = [new Api.MessageEmpty({ id: 42 })];
    await expect(h.storage.getPhoto(ctx, 42)).rejects.toBeInstanceOf(OriginalMissingError);
    h.messages = [undefined];
    await expect(h.storage.getPhoto(ctx, 42)).rejects.toBeInstanceOf(OriginalMissingError);
  });

  it('deletes in batches of 100, which is what channels.deleteMessages allows', async () => {
    await h.storage.deletePhotos(ctx, Array.from({ length: 250 }, (_, i) => i + 1));
    expect(h.deleted.map((d) => d.id.length)).toEqual([100, 100, 50]);
  });

  describe('when a connection goes quiet', () => {
    const never = () => new Promise<never>(() => undefined);
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const sender = (send: () => Promise<unknown>) => (async () => ({ dcId: 2, isConnected: () => true, send })) as unknown as TelegramClient['getSender'];

    /** Connections behave as `hang` says until `heal` is called. The ones made after that work. */
    function connections(hang: (client: TelegramClient) => void, stallMs = 30) {
      const clients: TelegramClient[] = [];
      const destroyed: TelegramClient[] = [];
      let broken = true;
      const storage = new TelegramStorage(1, 'hash', () => {
        const client = h.factory();
        if (broken) hang(client);
        client.destroy = async () => void destroyed.push(client);
        clients.push(client);
        return client;
      }, stallMs);
      return { storage, clients, destroyed, heal: () => { broken = false; } };
    }

    const photo = (bytes: Buffer) => ({ file: new Blob([bytes as BlobPart]), thumb: null, filename: 'a.jpg', mime: 'image/jpeg', size: bytes.length, caption: 'cap' });

    const reading = (storage: TelegramStorage) => async () => {
      let count = 0;
      for await (const _ of storage.scanLibrary(ctx)) count++;
      return count;
    };

    it('gives up on an upload part with no answer, then starts again on a new connection', async () => {
      const { storage, clients, destroyed, heal } = connections((client) => {
        client.getSender = sender(never);
      });
      const bytes = randomBytes(1024);

      await expect(storage.putPhoto(ctx, photo(bytes), () => {})).rejects.toBeInstanceOf(StalledError);
      await wait(0);
      expect(destroyed).toEqual([clients[0]]);

      heal();
      await expect(storage.putPhoto(ctx, photo(bytes), () => {})).resolves.toEqual({ messageId: 42 });
      expect(clients).toHaveLength(2);
      expect(h.reassembled().equals(bytes)).toBe(true);
    });

    it('gives up on a message that is never confirmed', async () => {
      const { storage } = connections((client) => {
        client.invoke = never as unknown as TelegramClient['invoke'];
      });
      await expect(storage.putPhoto(ctx, photo(randomBytes(1024)), () => {})).rejects.toBeInstanceOf(StalledError);
    });

    it('does not mistake a long upload for a stuck one, as long as each part gets an answer', async () => {
      const { storage } = connections((client) => {
        client.getSender = sender(async () => {
          await wait(60);
          return true;
        });
      }, 150);
      // Four rounds of parts at 60 ms each comes to well over the limit in total.
      const bytes = randomBytes(2 * 1024 * 1024);
      h.reply = (req) => documentReply(req, bytes.length);

      await expect(storage.putPhoto(ctx, photo(bytes), () => {})).resolves.toEqual({ messageId: 42 });
    });

    it('gives up on a scan with no answer, and the next scan uses a new connection', async () => {
      const { storage, clients } = connections((client) => {
        client.iterMessages = (() => ({ [Symbol.asyncIterator]: () => ({ next: never }) })) as unknown as TelegramClient['iterMessages'];
      });
      const scan = reading(storage);

      await expect(scan()).rejects.toBeInstanceOf(StalledError);
      await expect(scan()).rejects.toBeInstanceOf(StalledError);
      expect(clients).toHaveLength(2);
    });

    it('does not mistake a long scan for a stuck one, as long as each step gets an answer', async () => {
      const { storage } = connections((client) => {
        let left = 8;
        const next = async () => {
          await wait(50);
          return left-- > 0 ? { value: { media: null }, done: false } : { value: undefined, done: true };
        };
        client.iterMessages = (() => ({ [Symbol.asyncIterator]: () => ({ next }) })) as unknown as TelegramClient['iterMessages'];
      }, 200);

      await expect(reading(storage)()).resolves.toBe(0);
    });

    it('reads through real GramJS message paging one step at a time, oldest first', async () => {
      const message = (id: number) => Object.assign(storedMessage(10), { id });
      const storage = new TelegramStorage(1, 'hash', () => {
        const client = h.factory();
        client.invoke = (async (req: unknown) => {
          if (req instanceof Api.messages.GetHistory) {
            return new Api.messages.ChannelMessages({ pts: 1, count: 3, messages: [message(3), message(2), message(1)], topics: [], chats: [], users: [] });
          }
          throw new Error(`Unexpected request: ${(req as { className?: string }).className}`);
        }) as TelegramClient['invoke'];
        return client;
      });

      const ids: number[] = [];
      for await (const item of storage.scanLibrary(ctx)) ids.push(item.messageId);

      expect(ids).toEqual([1, 2, 3]);
    });

    it('gives up on reading or saving the synced state with no answer', async () => {
      const hung = () => connections((client) => {
        client.invoke = never as unknown as TelegramClient['invoke'];
      }).storage;
      await expect(hung().readState(ctx, null)).rejects.toBeInstanceOf(StalledError);
      await expect(hung().writeState(ctx, new Uint8Array([1, 2, 3]), null)).rejects.toBeInstanceOf(StalledError);
    });
  });

  describe('signing in', () => {
    function loginHarness(respond: (req: unknown) => unknown) {
      const client = new TelegramClient(new StringSession(''), 1, 'hash', { connectionRetries: 0 });
      client.connect = async () => true;
      client.destroy = async () => {};
      client.sendCode = (async () => ({ phoneCodeHash: 'hash', isCodeViaApp: true })) as TelegramClient['sendCode'];
      client.invoke = (async (req: unknown) => respond(req)) as TelegramClient['invoke'];
      (client.session as StringSession).save = () => 'SESSION-STRING';
      return new TelegramStorage(1, 'hash', () => client);
    }
    const user = new Api.User({ id: bigInt(5), firstName: 'Ada', phone: '15551234567', accessHash: bigInt(1) });

    it('completes with a code', async () => {
      const storage = loginHarness((req) => {
        if (req instanceof Api.auth.SignIn) {
          expect(req.phoneCode).toBe('12345');
          expect(req.phoneNumber).toBe('+15551234567');
          expect(req.phoneCodeHash).toBe('hash');
          return new Api.auth.Authorization({ user });
        }
        throw new Error('unexpected');
      });
      const { loginId, delivery } = await storage.sendLoginCode('+15551234567');
      expect(delivery).toBe('app');
      const result = await storage.submitLoginCode(loginId, '12345');
      expect(result).toEqual({
        status: 'ok',
        session: 'SESSION-STRING',
        user: { id: '5', firstName: 'Ada', lastName: '', username: '', phone: '+15551234567' },
      });
    });

    it('asks for the password when two-step verification is on', async () => {
      const storage = loginHarness((req) => {
        if (req instanceof Api.auth.SignIn) throw Object.assign(new Error('x'), { errorMessage: 'SESSION_PASSWORD_NEEDED' });
        if (req instanceof Api.account.GetPassword) return { hint: 'my dog' };
        throw new Error('unexpected');
      });
      const { loginId } = await storage.sendLoginCode('+15551234567');
      expect(await storage.submitLoginCode(loginId, '12345')).toEqual({ status: 'needs-password', hint: 'my dog' });
    });

    it('explains a wrong code and allows another try', async () => {
      let calls = 0;
      const storage = loginHarness(() => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('x'), { errorMessage: 'PHONE_CODE_INVALID' });
        return new Api.auth.Authorization({ user });
      });
      const { loginId } = await storage.sendLoginCode('+15551234567');
      await expect(storage.submitLoginCode(loginId, '000')).rejects.toMatchObject({ code: 'CODE_INVALID' });
      expect((await storage.submitLoginCode(loginId, '12345')).status).toBe('ok');
    });

    it('rejects a sign-in id it never issued', async () => {
      const storage = loginHarness(() => null);
      await expect(storage.submitLoginCode('nope', '1')).rejects.toBeInstanceOf(UserFacingError);
    });
  });
});
