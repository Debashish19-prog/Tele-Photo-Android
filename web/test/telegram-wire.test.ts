/**
 * These tests run the real GramJS upload and download code, and replace only the network socket.
 * They pin down the exact requests sent to Telegram, because those requests are what decide
 * whether a photo keeps its quality. They cannot prove how Telegram's servers respond. That
 * is what "Check Telegram storage" in the account menu is for.
 */
import bigInt from 'big-integer';
import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Api, TelegramClient, errors } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { TelegramStorage } from '../src/engine/telegram';
import { OriginalMissingError, RateLimitedError, SessionRevokedError, type StorageContext } from '../src/engine/types';

const CTX: StorageContext = { session: '', library: { channelId: '1234', accessHash: '5678' } };

interface Wire {
  client: TelegramClient;
  parts: Map<number, Buffer>;
  partRequests: (Api.upload.SaveBigFilePart | Api.upload.SaveFilePart)[];
  invoked: unknown[];
  storedSize: () => number;
  /** Replaces the media that Telegram reports back after sending. */
  mediaOverride: Api.TypeMessageMedia | null;
  failSendWith: Error | null;
  maxLiveBytes: number;
}

function document(size: number): Api.Document {
  return new Api.Document({
    id: bigInt(99), accessHash: bigInt(1), fileReference: Buffer.from([1]), date: 0, mimeType: 'image/jpeg',
    size: bigInt(size), dcId: 2, attributes: [],
  });
}

function makeWire(): Wire {
  const client = new TelegramClient(new StringSession(''), 1, 'hash', { connectionRetries: 0 });
  const wire: Wire = {
    client, parts: new Map(), partRequests: [], invoked: [], mediaOverride: null, failSendWith: null, maxLiveBytes: 0,
    storedSize: () => [...wire.parts.values()].reduce((n, b) => n + b.length, 0),
  };

  const stub = client as unknown as Record<string, unknown>;
  stub.connect = async () => true;
  stub.destroy = async () => undefined;
  Object.defineProperty(client, 'connected', { get: () => true });
  stub.getSender = async () => ({
    dcId: 2,
    isConnected: () => true,
    send: async (req: Api.upload.SaveBigFilePart | Api.upload.SaveFilePart) => {
      wire.partRequests.push(req);
      wire.parts.set(req.filePart, Buffer.from(req.bytes));
      return true;
    },
  });
  stub.invoke = async (req: unknown) => {
    wire.invoked.push(req);
    if (req instanceof Api.messages.SendMedia) {
      if (wire.failSendWith) throw wire.failSendWith;
      const media = wire.mediaOverride ?? new Api.MessageMediaDocument({ document: document(wire.storedSize()) });
      const message = new Api.Message({
        id: 777, peerId: new Api.PeerChannel({ channelId: bigInt(1234) }), date: 0, message: req.message, media,
      });
      return new Api.Updates({
        updates: [
          new Api.UpdateMessageID({ id: 777, randomId: req.randomId }),
          new Api.UpdateNewChannelMessage({ message, pts: 1, ptsCount: 1 }),
        ],
        users: [], chats: [], date: 0, seq: 0,
      });
    }
    return true;
  };
  return wire;
}

function storageOver(wire: Wire): TelegramStorage {
  return new TelegramStorage(1, 'hash', () => wire.client);
}

describe('storing a photo on the Telegram wire', () => {
  let wire: Wire;
  beforeEach(() => {
    wire = makeWire();
  });

  async function put(name: string, data: Buffer, mime: string) {
    return storageOver(wire).putPhoto(CTX, { file: new Blob([data as BlobPart]), thumb: null, filename: name, mime, size: data.length, caption: 'cap' }, () => undefined);
  }

  const sentMedia = () => {
    const req = wire.invoked.find((r) => r instanceof Api.messages.SendMedia) as Api.messages.SendMedia;
    return req.media as Api.InputMediaUploadedDocument;
  };

  // The heart of "the quality stays intact": these extensions are the ones GramJS's sendFile gets wrong.
  it.each([
    ['photo.jpg', 'image/jpeg'],
    ['PHOTO.JPEG', 'image/jpeg'],
    ['shot.png', 'image/png'],
    ['anim.gif', 'image/gif'],
    ['pic.webp', 'image/webp'],
    ['iphone.heic', 'image/heic'],
  ])('sends %s as an uncompressed file, never as a photo', async (name, mime) => {
    await put(name, randomBytes(4096), mime);
    const media = sentMedia();
    expect(media).toBeInstanceOf(Api.InputMediaUploadedDocument);
    expect(media.forceFile).toBe(true);
    expect(media.mimeType).toBe(mime);
    expect(media.attributes).toHaveLength(1);
    expect((media.attributes[0] as Api.DocumentAttributeFilename).fileName).toBe(name);
  });

  it('produces a request GramJS can really serialize for the wire', async () => {
    await put('photo.jpg', randomBytes(1024), 'image/jpeg');
    const req = wire.invoked.find((r) => r instanceof Api.messages.SendMedia) as Api.messages.SendMedia;
    expect(req.getBytes().length).toBeGreaterThan(0);
  });

  it('delivers exactly the source bytes, in one file and one message', async () => {
    const data = randomBytes(3 * 1024 * 1024 + 123);
    const result = await put('photo.jpg', data, 'image/jpeg');
    expect(result.messageId).toBe(777);
    const parts = [...wire.parts.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
    expect(createHash('sha256').update(Buffer.concat(parts)).digest('hex')).toBe(createHash('sha256').update(data).digest('hex'));
    expect(wire.invoked.filter((r) => r instanceof Api.messages.SendMedia)).toHaveLength(1);
  });

  it('switches to big-file parts above 10 MB', async () => {
    const data = randomBytes(21 * 1024 * 1024);
    await put('large.png', data, 'image/png');
    expect(wire.partRequests[0]).toBeInstanceOf(Api.upload.SaveBigFilePart);
    const parts = [...wire.parts.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
    expect(Buffer.concat(parts).equals(data)).toBe(true);
    expect((sentMedia().file as Api.InputFileBig).className).toBe('InputFileBig');
  });

  // The largest-file case lives in telegram.test.ts, which also checks that memory stays bounded.

  it('rejects the result if Telegram kept a compressed photo instead', async () => {
    wire.mediaOverride = new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: bigInt(1) }) });
    await expect(put('photo.jpg', randomBytes(2048), 'image/jpeg')).rejects.toThrow(/unmodified/);
    // The altered copy is removed, not left behind as clutter.
    expect(wire.invoked.some((r) => r instanceof Api.channels.DeleteMessages)).toBe(true);
  });

  it('rejects the result if the stored size differs by even one byte', async () => {
    wire.mediaOverride = new Api.MessageMediaDocument({ document: document(2047) });
    await expect(put('photo.jpg', randomBytes(2048), 'image/jpeg')).rejects.toThrow(/unmodified/);
  });

  it('reports a flood wait as a pause rather than a failure', async () => {
    wire.failSendWith = new errors.FloodWaitError({ request: {} as never, capture: 42 } as never);
    await expect(put('photo.jpg', randomBytes(100), 'image/jpeg')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('reports a revoked session distinctly', async () => {
    wire.failSendWith = Object.assign(new Error('x'), { errorMessage: 'AUTH_KEY_UNREGISTERED' });
    await expect(put('photo.jpg', randomBytes(100), 'image/jpeg')).rejects.toBeInstanceOf(SessionRevokedError);
  });
});

describe('reading a photo back over the wire', () => {
  function wireServing(data: Buffer | null) {
    const wire = makeWire();
    const stub = wire.client as unknown as Record<string, unknown>;
    const requests: Api.upload.GetFile[] = [];
    stub.getMessages = async () => {
      if (!data) return [undefined];
      return [new Api.Message({
        id: 5, peerId: new Api.PeerChannel({ channelId: bigInt(1234) }), date: 0, message: '',
        media: new Api.MessageMediaDocument({ document: document(data.length) }),
      })];
    };
    stub.invokeWithSender = async (req: Api.upload.GetFile) => {
      requests.push(req);
      const offset = req.offset.toJSNumber();
      return new Api.upload.File({ type: new Api.storage.FilePartial(), mtime: 0, bytes: data!.subarray(offset, offset + req.limit) });
    };
    return { wire, requests };
  }

  it.each([
    ['smaller than one chunk', 1000],
    ['exactly one chunk', 512 * 1024],
    ['exactly several chunks', 3 * 512 * 1024],
    ['one byte over a chunk', 512 * 1024 + 1],
    ['several chunks and a bit', 5 * 512 * 1024 + 777],
  ])('returns every byte when the file is %s', async (_label, size) => {
    const data = randomBytes(size);
    const { wire, requests } = wireServing(data);
    const { size: reported, stream } = await storageOver(wire).getPhoto(CTX, 5);
    expect(reported).toBe(size);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
    // Telegram rejects reads that are not aligned to these sizes.
    for (const r of requests) {
      expect(r.limit).toBe(512 * 1024);
      expect(r.offset.toJSNumber() % (4 * 1024)).toBe(0);
    }
  });

  it('says clearly when the message is gone', async () => {
    const { wire } = wireServing(null);
    await expect(storageOver(wire).getPhoto(CTX, 5)).rejects.toBeInstanceOf(OriginalMissingError);
  });

  describe('reading only part of a file, as seeking in a video does', () => {
    const BLOCK = 512 * 1024;
    const SIZE = 3 * BLOCK + 777;

    it.each([
      ['within one block', 1000, 2000],
      ['across blocks, from an unaligned start', 300_000, 1_200_000],
      ['exactly one block', BLOCK, 2 * BLOCK],
      ['in the last, short block', SIZE - 100, SIZE],
      ['a single byte', BLOCK, BLOCK + 1],
    ])('returns just those bytes when the range is %s', async (_label, start, end) => {
      const data = randomBytes(SIZE);
      const { wire, requests } = wireServing(data);
      const bytes = await storageOver(wire).getPhotoRange(CTX, 5, start, end);
      expect(Buffer.from(bytes).equals(data.subarray(start, end))).toBe(true);
      // Telegram rejects reads that are not aligned to these sizes.
      for (const r of requests) {
        expect(r.limit).toBe(BLOCK);
        expect(r.offset.toJSNumber() % BLOCK).toBe(0);
      }
      expect(requests).toHaveLength(Math.ceil(end / BLOCK) - Math.floor(start / BLOCK));
    });

    it('does not look the message up again for every read', async () => {
      const data = randomBytes(SIZE);
      const { wire } = wireServing(data);
      const stub = wire.client as unknown as Record<string, unknown>;
      const getMessages = stub.getMessages as () => Promise<unknown>;
      let lookups = 0;
      stub.getMessages = () => {
        lookups++;
        return getMessages();
      };
      const storage = storageOver(wire);
      await storage.getPhotoRange(CTX, 5, 0, 100);
      await storage.getPhotoRange(CTX, 5, BLOCK, BLOCK + 100);
      expect(lookups).toBe(1);
    });

    it('gets a new file reference and tries again when the old one has expired', async () => {
      const data = randomBytes(SIZE);
      const { wire } = wireServing(data);
      const stub = wire.client as unknown as Record<string, unknown>;
      const serve = stub.invokeWithSender as (req: Api.upload.GetFile) => Promise<unknown>;
      let refused = false;
      stub.invokeWithSender = async (req: Api.upload.GetFile) => {
        if (!refused) {
          refused = true;
          throw Object.assign(new Error('expired'), { errorMessage: 'FILE_REFERENCE_EXPIRED' });
        }
        return serve(req);
      };
      const bytes = await storageOver(wire).getPhotoRange(CTX, 5, 10, 20);
      expect(Buffer.from(bytes).equals(data.subarray(10, 20))).toBe(true);
    });

    it('says clearly when the message is gone', async () => {
      const { wire } = wireServing(null);
      await expect(storageOver(wire).getPhotoRange(CTX, 5, 0, 10)).rejects.toBeInstanceOf(OriginalMissingError);
    });
  });
});

describe('signing in', () => {
  function wireWithLogin(behaviour: (req: unknown) => unknown) {
    const wire = makeWire();
    const stub = wire.client as unknown as Record<string, unknown>;
    stub.sendCode = async () => ({ phoneCodeHash: 'hash', isCodeViaApp: true });
    stub.invoke = async (req: unknown) => {
      wire.invoked.push(req);
      return behaviour(req);
    };
    return wire;
  }

  const user = new Api.User({ id: bigInt(42), firstName: 'Ada', lastName: 'L', username: 'ada', phone: '15550000001' });

  it('completes with a code', async () => {
    const wire = wireWithLogin((req) => {
      if (req instanceof Api.auth.SignIn) {
        expect(req.phoneCode).toBe('11111');
        expect(req.phoneCodeHash).toBe('hash');
        return new Api.auth.Authorization({ user });
      }
    });
    const storage = storageOver(wire);
    const { loginId, delivery } = await storage.sendLoginCode('+15550000001');
    expect(delivery).toBe('app');
    const result = await storage.submitLoginCode(loginId, '11111');
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.user).toMatchObject({ id: '42', firstName: 'Ada', phone: '+15550000001' });
    }
  });

  it('asks for the password when two-step verification is on', async () => {
    const wire = wireWithLogin((req) => {
      if (req instanceof Api.auth.SignIn) throw Object.assign(new Error('x'), { errorMessage: 'SESSION_PASSWORD_NEEDED' });
      if (req instanceof Api.account.GetPassword) return { hint: 'first pet' };
    });
    const storage = storageOver(wire);
    const { loginId } = await storage.sendLoginCode('+15550000001');
    expect(await storage.submitLoginCode(loginId, '11111')).toEqual({ status: 'needs-password', hint: 'first pet' });
  });

  it('explains a wrong code and allows another try', async () => {
    let tries = 0;
    const wire = wireWithLogin((req) => {
      if (req instanceof Api.auth.SignIn) {
        if (tries++ === 0) throw Object.assign(new Error('x'), { errorMessage: 'PHONE_CODE_INVALID' });
        return new Api.auth.Authorization({ user });
      }
    });
    const storage = storageOver(wire);
    const { loginId } = await storage.sendLoginCode('+15550000001');
    await expect(storage.submitLoginCode(loginId, '00000')).rejects.toMatchObject({ code: 'CODE_INVALID' });
    expect((await storage.submitLoginCode(loginId, '11111')).status).toBe('ok');
  });

  it('refuses an unknown login id', async () => {
    const storage = storageOver(makeWire());
    await expect(storage.submitLoginCode('nope', '1')).rejects.toMatchObject({ code: 'LOGIN_EXPIRED' });
  });
});

describe('the library channel', () => {
  it('creates a broadcast channel when none exists', async () => {
    const wire = makeWire();
    const stub = wire.client as unknown as Record<string, unknown>;
    stub.iterDialogs = async function* () {};
    const channel = new Api.Channel({ id: bigInt(77), accessHash: bigInt(88), title: 't', photo: new Api.ChatPhotoEmpty(), date: 0 });
    stub.invoke = async (req: unknown) => {
      wire.invoked.push(req);
      if (req instanceof Api.channels.CreateChannel) {
        expect(req.broadcast).toBe(true);
        return new Api.Updates({ updates: [], users: [], chats: [channel], date: 0, seq: 0 });
      }
    };
    const result = await storageOver(wire).ensureLibrary('');
    expect(result).toEqual({ library: { channelId: '77', accessHash: '88' }, existing: false });
  });

  it('reconnects to an existing library instead of making a second one', async () => {
    const wire = makeWire();
    const stub = wire.client as unknown as Record<string, unknown>;
    const channel = new Api.Channel({ id: bigInt(77), accessHash: bigInt(88), title: 'Tele-Photo Library', creator: true, photo: new Api.ChatPhotoEmpty(), date: 0 });
    stub.iterDialogs = async function* () { yield { entity: channel }; };
    stub.invoke = async (req: unknown) => {
      wire.invoked.push(req);
      if (req instanceof Api.channels.GetFullChannel) return { fullChat: { about: 'x tele-photo-library:v1' } };
      throw new Error('must not create another channel');
    };
    expect(await storageOver(wire).ensureLibrary('')).toEqual({ library: { channelId: '77', accessHash: '88' }, existing: true });
  });

  it('ignores a look-alike channel without the marker', async () => {
    const wire = makeWire();
    const stub = wire.client as unknown as Record<string, unknown>;
    const lookalike = new Api.Channel({ id: bigInt(1), accessHash: bigInt(2), title: 'Tele-Photo Library', creator: true, photo: new Api.ChatPhotoEmpty(), date: 0 });
    const created = new Api.Channel({ id: bigInt(3), accessHash: bigInt(4), title: 't', photo: new Api.ChatPhotoEmpty(), date: 0 });
    stub.iterDialogs = async function* () { yield { entity: lookalike }; };
    stub.invoke = async (req: unknown) => {
      if (req instanceof Api.channels.GetFullChannel) return { fullChat: { about: 'someone else' } };
      if (req instanceof Api.channels.CreateChannel) return new Api.Updates({ updates: [], users: [], chats: [created], date: 0, seq: 0 });
    };
    expect((await storageOver(wire).ensureLibrary('')).library.channelId).toBe('3');
  });
});

describe('finding thumbnails', () => {
  function photoMessage(id: number, thumbs: Api.TypePhotoSize[]) {
    return new Api.Message({
      id, peerId: new Api.PeerChannel({ channelId: bigInt(1234) }), date: 0, message: '',
      media: new Api.MessageMediaDocument({
        document: new Api.Document({
          id: bigInt(id), accessHash: bigInt(1), fileReference: Buffer.from([1]), date: 0, mimeType: 'image/jpeg',
          size: bigInt(5000), dcId: 2, attributes: [], thumbs,
        }),
      }),
    });
  }
  const real = (type: string, w: number) => new Api.PhotoSize({ type, w, h: w, size: 100 });
  const stripped = () => new Api.PhotoStrippedSize({ type: 'i', bytes: Buffer.from([1, 40, 40]) });

  function setup(messages: Api.Message[]) {
    const wire = makeWire();
    const stub = wire.client as unknown as Record<string, unknown>;
    const lookups: number[][] = [];
    const downloads: string[] = [];
    stub.getMessages = async (_peer: unknown, options: { ids: number[] }) => {
      lookups.push(options.ids);
      return messages.filter((m) => options.ids.includes(m.id));
    };
    stub.downloadMedia = async (_media: unknown, options: { thumb: string }) => {
      downloads.push(options.thumb);
      return Buffer.from('jpeg-bytes');
    };
    return { wire, stub, lookups, downloads, storage: storageOver(wire) };
  }

  it('asks for the largest real thumbnail', async () => {
    const { storage, downloads } = setup([photoMessage(1, [stripped(), real('s', 90), real('m', 320)])]);
    const blob = await storage.getThumb(CTX, 1);
    expect(await blob!.text()).toBe('jpeg-bytes');
    expect(downloads).toEqual(['m']);
  });

  it('does not count a stripped blur as a thumbnail', async () => {
    const { storage, downloads } = setup([photoMessage(1, [stripped()])]);
    expect(await storage.getThumb(CTX, 1)).toBeNull();
    expect(downloads).toEqual([]);
  });

  it('shares one lookup between thumbnails asked for together, and matches them up by id', async () => {
    // In the reverse of the order they are asked for, in case Telegram does not keep to it.
    const { storage, lookups } = setup([photoMessage(3, [real('m', 320)]), photoMessage(2, [real('m', 320)]), photoMessage(1, [real('s', 90)])]);
    const blobs = await Promise.all([1, 2, 3].map((id) => storage.getThumb(CTX, id)));
    expect(blobs.every((b) => b !== null)).toBe(true);
    expect(lookups).toEqual([[1, 2, 3]]);
  });

  it('splits a very long list into as many lookups as it takes', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const { storage, lookups } = setup(ids.map((id) => photoMessage(id, [real('m', 320)])));
    await Promise.all(ids.map((id) => storage.getThumb(CTX, id)));
    expect(lookups.map((l) => l.length)).toEqual([100, 100, 50]);
  });

  it('remembers what it looked up', async () => {
    const { storage, lookups } = setup([photoMessage(1, [real('m', 320)])]);
    await storage.getThumb(CTX, 1);
    await storage.getThumb(CTX, 1);
    expect(lookups).toHaveLength(1);
  });

  it('gets a fresh reference and tries again when an old one has expired', async () => {
    const { storage, stub, lookups } = setup([photoMessage(1, [real('m', 320)])]);
    await storage.getThumb(CTX, 1);
    let calls = 0;
    stub.downloadMedia = async () => {
      if (calls++ === 0) throw Object.assign(new Error('x'), { errorMessage: 'FILE_REFERENCE_EXPIRED' });
      return Buffer.from('fresh');
    };
    const blob = await storage.getThumb(CTX, 1);
    expect(await blob!.text()).toBe('fresh');
    expect(lookups).toHaveLength(2);
  });

  it('gives up cleanly when a photo has gone', async () => {
    const { storage } = setup([]);
    expect(await storage.getThumb(CTX, 99)).toBeNull();
  });

  it('reports a revoked session distinctly here too', async () => {
    const { storage, stub } = setup([photoMessage(1, [real('m', 320)])]);
    stub.downloadMedia = async () => {
      throw Object.assign(new Error('x'), { errorMessage: 'SESSION_REVOKED' });
    };
    await expect(storage.getThumb(CTX, 1)).rejects.toBeInstanceOf(SessionRevokedError);
  });
});

describe('scanning the channel', () => {
  it('reads oldest first, from where it left off, and says which photos have thumbnails', async () => {
    const wire = makeWire();
    const stub = wire.client as unknown as Record<string, unknown>;
    let seen: { reverse?: boolean; minId?: number } = {};
    const message = (id: number, thumbs: Api.TypePhotoSize[]) => new Api.Message({
      id, peerId: new Api.PeerChannel({ channelId: bigInt(1234) }), date: 7, message: 'cap',
      media: new Api.MessageMediaDocument({
        document: new Api.Document({ id: bigInt(id), accessHash: bigInt(1), fileReference: Buffer.from([1]), date: 0, mimeType: 'image/png', size: bigInt(9), dcId: 2, attributes: [new Api.DocumentAttributeFilename({ fileName: 'a.png' })], thumbs }),
      }),
    });
    stub.iterMessages = async function* (_peer: unknown, options: typeof seen) {
      seen = options;
      yield message(11, [new Api.PhotoSize({ type: 'm', w: 320, h: 240, size: 100 })]);
      yield new Api.Message({ id: 12, peerId: new Api.PeerChannel({ channelId: bigInt(1234) }), date: 7, message: 'text, no file' });
      yield message(13, []);
    };
    const found = [];
    for await (const item of storageOver(wire).scanLibrary(CTX, { afterMessageId: 10 })) found.push(item);
    expect(seen).toMatchObject({ reverse: true, minId: 10 });
    expect(found.map((f) => [f.messageId, f.hasThumb, f.filename])).toEqual([[11, true, 'a.png'], [13, false, 'a.png']]);
  });
});

describe('the synced state', () => {
  function stateMessage(id: number, documentId: number) {
    return new Api.Message({
      id, peerId: new Api.PeerChannel({ channelId: bigInt(1234) }), date: 1, message: 'telephoto-state:v1',
      media: new Api.MessageMediaDocument({
        document: new Api.Document({ id: bigInt(documentId), accessHash: bigInt(1), fileReference: Buffer.from([1]), date: 0, mimeType: 'application/gzip', size: bigInt(3), dcId: 2, attributes: [] }),
      }),
    });
  }

  function setup(options: { pinned?: Api.Message; searchResult?: Api.Message } = {}) {
    const wire = makeWire();
    const stub = wire.client as unknown as Record<string, unknown>;
    let downloads = 0;
    const invoked: unknown[] = [];
    let nextDocument = 500;
    stub.invoke = async (req: unknown) => {
      invoked.push(req);
      if (req instanceof Api.channels.GetFullChannel) {
        return { fullChat: new Api.ChannelFull({ id: bigInt(1234), about: '', readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, chatPhoto: new Api.PhotoEmpty({ id: bigInt(0) }), notifySettings: new Api.PeerNotifySettings({}), botInfo: [], pts: 0, pinnedMsgId: options.pinned?.id }) };
      }
      if (req instanceof Api.messages.SendMedia) {
        const message = stateMessage(900, nextDocument++);
        return new Api.Updates({ updates: [new Api.UpdateMessageID({ id: 900, randomId: req.randomId }), new Api.UpdateNewChannelMessage({ message, pts: 1, ptsCount: 1 })], users: [], chats: [], date: 0, seq: 0 });
      }
      if (req instanceof Api.messages.EditMessage) {
        const message = stateMessage(req.id, nextDocument++);
        return new Api.Updates({ updates: [new Api.UpdateEditChannelMessage({ message, pts: 1, ptsCount: 1 })], users: [], chats: [], date: 0, seq: 0 });
      }
      return true;
    };
    stub.getMessages = async (_peer: unknown, query: { ids?: number[]; search?: string }) => {
      if (query.search) return options.searchResult ? [options.searchResult] : [];
      return options.pinned && query.ids?.includes(options.pinned.id) ? [options.pinned] : [];
    };
    stub.downloadMedia = async () => {
      downloads++;
      return Buffer.from([1, 2, 3]);
    };
    return { wire, stub, invoked, storage: storageOver(wire), downloads: () => downloads };
  }

  it('finds the pinned copy straight away', async () => {
    const { storage } = setup({ pinned: stateMessage(50, 7) });
    const result = await storage.readState(CTX, null);
    expect(result).toMatchObject({ changed: true, file: { messageId: 50, version: 7, bytes: new Uint8Array([1, 2, 3]) } });
  });

  it('does not download a copy it already has', async () => {
    const { storage, downloads } = setup({ pinned: stateMessage(50, 7) });
    expect(await storage.readState(CTX, { messageId: 50, version: 7 })).toEqual({ changed: false });
    expect(downloads()).toBe(0);
  });

  it('notices a new copy even if it was saved within the same second', async () => {
    const { storage } = setup({ pinned: stateMessage(50, 8) });
    expect((await storage.readState(CTX, { messageId: 50, version: 7 })).changed).toBe(true);
  });

  it('finds it by search if someone unpinned it', async () => {
    const { storage } = setup({ searchResult: stateMessage(51, 9) });
    expect(await storage.readState(CTX, null)).toMatchObject({ changed: true, file: { messageId: 51 } });
  });

  it('is not fooled by some other pinned message', async () => {
    const other = new Api.Message({ id: 52, peerId: new Api.PeerChannel({ channelId: bigInt(1234) }), date: 1, message: 'my favorite photo' });
    const { storage } = setup({ pinned: other });
    expect(await storage.readState(CTX, null)).toEqual({ changed: true, file: null });
  });

  it('starts one pinned message the first time, silently', async () => {
    const { storage, invoked } = setup();
    const saved = await storage.writeState(CTX, new Uint8Array([1]), null);
    expect(saved.messageId).toBe(900);
    const pin = invoked.find((r) => r instanceof Api.messages.UpdatePinnedMessage) as Api.messages.UpdatePinnedMessage;
    expect(pin.id).toBe(900);
    expect(pin.silent).toBe(true);
    const send = invoked.find((r) => r instanceof Api.messages.SendMedia) as Api.messages.SendMedia;
    expect(send.silent).toBe(true);
    expect((send.media as Api.InputMediaUploadedDocument).forceFile).toBe(true);
    expect(send.getBytes().length).toBeGreaterThan(0);
  });

  it('after that replaces the file inside the same message, so old copies never pile up', async () => {
    const { storage, invoked } = setup();
    const saved = await storage.writeState(CTX, new Uint8Array([1]), { messageId: 50, version: 7 });
    expect(saved.messageId).toBe(50);
    expect(saved.version).not.toBe(7);
    expect(invoked.some((r) => r instanceof Api.messages.SendMedia)).toBe(false);
    expect(invoked.some((r) => r instanceof Api.messages.UpdatePinnedMessage)).toBe(false);
    const edit = invoked.find((r) => r instanceof Api.messages.EditMessage) as Api.messages.EditMessage;
    expect(edit.getBytes().length).toBeGreaterThan(0);
  });

  it('starts a new message if the old one cannot be edited, and removes the old one', async () => {
    const { storage, stub, invoked } = setup();
    const invoke = stub.invoke as (req: unknown) => Promise<unknown>;
    stub.invoke = async (req: unknown) => {
      if (req instanceof Api.messages.EditMessage) {
        invoked.push(req);
        throw Object.assign(new Error('x'), { errorMessage: 'MESSAGE_ID_INVALID' });
      }
      return invoke(req);
    };
    const saved = await storage.writeState(CTX, new Uint8Array([1]), { messageId: 50, version: 7 });
    expect(saved.messageId).toBe(900);
    const removed = invoked.find((r) => r instanceof Api.channels.DeleteMessages) as Api.channels.DeleteMessages;
    expect(removed.id).toEqual([50]);
  });

  it('waits rather than starting over when Telegram asks it to slow down', async () => {
    const { storage, stub, invoked } = setup();
    stub.invoke = async (req: unknown) => {
      invoked.push(req);
      throw new errors.FloodWaitError({ request: {} as never, capture: 42 } as never);
    };
    await expect(storage.writeState(CTX, new Uint8Array([1]), { messageId: 50, version: 7 })).rejects.toBeInstanceOf(RateLimitedError);
    expect(invoked.some((r) => r instanceof Api.messages.SendMedia)).toBe(false);
  });
});
