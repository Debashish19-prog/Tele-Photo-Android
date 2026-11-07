import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDisk } from '../src/engine/fake';
import { decodeDoc, encodeDoc } from '../src/engine/sync';
import { Device, makeJpeg } from './helpers';

const SESSION = 'fake:+15550000001';
const CTX = { session: SESSION, library: { channelId: encodeURIComponent(SESSION), accessHash: '0' } };

/** Two browsers signed in to one account, sharing one pretend Telegram. */
describe('between devices', () => {
  let phone: Device;
  let laptop: Device;

  beforeEach(async () => {
    const disk = memoryDisk();
    phone = await new Device(disk).open();
    laptop = await new Device(disk).open();
    await phone.signIn();
    await laptop.signIn();
  });
  afterEach(async () => {
    await phone.close();
    await laptop.close();
  });

  const idOn = (device: Device, filename: string) => device.engine.photos({ view: undefined }).concat(device.engine.photos({ view: 'trash' })).find((p) => p.filename === filename)!.id;

  it('a photo added on one shows up on the other, with no original downloaded', async () => {
    await phone.stored(makeJpeg({ camera: 'Pixel 9', date: '2024:01:02 03:04:05' }), 'from-phone.jpg');
    await phone.saveState();
    laptop.storage.fetchCount = 0;

    await laptop.catchUp();

    expect(laptop.names()).toEqual(['from-phone.jpg']);
    const id = idOn(laptop, 'from-phone.jpg');
    expect(laptop.engine.photo(id).camera.model).toBe('Pixel 9');
    expect(await laptop.engine.thumb(id)).not.toBeNull();
    expect(laptop.storage.fetchCount).toBe(0);
  });

  it('a change made while a save is going up is saved too, rather than lost', async () => {
    await phone.stored(makeJpeg({ color: '#aaa' }), 'keep.jpg');
    await phone.stored(makeJpeg({ color: '#bbb' }), 'gone.jpg');
    await laptop.catchUp();
    const id = idOn(phone, 'gone.jpg');
    await phone.engine.setTrashed([id], true);

    const real = phone.storage.writeState.bind(phone.storage);
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let started = false;
    phone.storage.writeState = async (...args) => {
      started = true;
      await held;
      return real(...args);
    };
    const saving = phone.engine.sync.flush();
    await vi.waitFor(() => expect(started).toBe(true));
    await phone.engine.deleteForever([id]);
    letGo();
    await saving;
    phone.storage.writeState = real;

    expect(phone.engine.sync.hasUnsavedChanges).toBe(true);
    await phone.engine.sync.flush();
    expect(phone.engine.sync.hasUnsavedChanges).toBe(false);

    await laptop.catchUp();
    expect(laptop.engine.store.allPhotos().map((p) => p.filename)).toEqual(['keep.jpg']);
  });

  it('a photo already on the other device is recognised, not stored twice', async () => {
    const bytes = makeJpeg({ color: '#123456' });
    await phone.stored(bytes, 'shot.jpg');
    await laptop.catchUp();
    expect((await laptop.add(bytes, 'shot-copy.jpg')).duplicate).toBe(true);
    await laptop.engine.queue.drain();
    expect(await laptop.storage.storedCount(SESSION)).toBe(1);
  });

  it('favorites and Trash carry across', async () => {
    const a = await phone.stored(makeJpeg({ color: '#010203' }), 'a.jpg');
    const b = await phone.stored(makeJpeg({ color: '#040506' }), 'b.jpg');
    await laptop.catchUp();

    await phone.engine.setFavorite([a], true);
    await phone.engine.setTrashed([b], true);
    await phone.saveState();
    await laptop.catchUp();

    expect(laptop.engine.photo(idOn(laptop, 'a.jpg')).favorite).toBe(true);
    expect(laptop.names()).toEqual(['a.jpg']);
    expect(laptop.names({ view: 'trash' })).toEqual(['b.jpg']);
  });

  it('takes the later of two changes to the same photo', async () => {
    const a = await phone.stored(makeJpeg(), 'a.jpg');
    await laptop.catchUp();
    const onLaptop = idOn(laptop, 'a.jpg');

    await phone.engine.setFavorite([a], true);
    await new Promise((r) => setTimeout(r, 5));
    await laptop.engine.setFavorite([onLaptop], false);
    await phone.saveState();
    await laptop.saveState();
    await phone.catchUp();

    expect(phone.engine.photo(a).favorite).toBe(false);
    expect(laptop.engine.photo(onLaptop).favorite).toBe(false);
  });

  it('keeps both when each device changes a different photo', async () => {
    const a = await phone.stored(makeJpeg({ color: '#111111' }), 'a.jpg');
    await phone.stored(makeJpeg({ color: '#222222' }), 'b.jpg');
    await laptop.catchUp();

    await phone.engine.setFavorite([a], true);
    await laptop.engine.setFavorite([idOn(laptop, 'b.jpg')], true);
    await phone.saveState();
    await laptop.saveState();
    await phone.catchUp();

    const favorites = (device: Device) => device.names({ view: 'favorites' }).sort();
    expect(favorites(laptop)).toEqual(['a.jpg', 'b.jpg']);
    expect(favorites(phone)).toEqual(['a.jpg', 'b.jpg']);
  });

  it('notices if another save overwrote its change, and puts it back', async () => {
    const a = await phone.stored(makeJpeg({ color: '#333333' }), 'a.jpg');
    await laptop.catchUp();
    await phone.engine.setFavorite([a], true);
    await phone.saveState();

    // Laptop saved from an old copy at the same moment, so the phone's favorite is no longer in the file.
    await phone.storage.writeState(CTX, await encodeDoc({ v: 1, photos: {}, albums: {} }), null);

    await phone.engine.sync.pull();
    expect(phone.engine.sync.hasUnsavedChanges).toBe(true);
    await phone.saveState();
    await laptop.catchUp();
    expect(laptop.engine.photo(idOn(laptop, 'a.jpg')).favorite).toBe(true);
  });

  it('albums carry across, including what is in them', async () => {
    const a = await phone.stored(makeJpeg({ color: '#444444' }), 'a.jpg');
    const { id } = await phone.engine.createAlbum('Goa', [a]);
    await phone.saveState();
    await laptop.catchUp();

    expect(laptop.engine.albums()[0]).toMatchObject({ title: 'Goa', photoCount: 1 });

    await phone.engine.updateAlbum(id, { title: 'Goa 2024' });
    await phone.saveState();
    await laptop.catchUp();
    expect(laptop.engine.albums()[0]!.title).toBe('Goa 2024');
  });

  it('fills an album in once a photo it names finally arrives', async () => {
    const { id } = await phone.engine.createAlbum('Later');
    const a = await phone.addOk(makeJpeg({ color: '#454545' }), 'a.jpg');
    await phone.engine.addToAlbum(id, [a]);
    // The album reaches the laptop before the photo has reached Telegram.
    phone.storage.putDelayMs = 50;
    await phone.saveState();
    await laptop.engine.sync.pull();
    expect(laptop.engine.albums()[0]).toMatchObject({ title: 'Later', photoCount: 0 });

    await phone.engine.queue.drain();
    await laptop.catchUp();
    expect(laptop.engine.albums()[0]).toMatchObject({ title: 'Later', photoCount: 1 });
  });

  it('deleting an album on one removes it from the other, but keeps the photos', async () => {
    const a = await phone.stored(makeJpeg({ color: '#555555' }), 'a.jpg');
    const { id } = await phone.engine.createAlbum('Temp', [a]);
    await phone.saveState();
    await laptop.catchUp();
    expect(laptop.engine.albums()).toHaveLength(1);

    await phone.engine.deleteAlbum(id);
    await phone.saveState();
    await laptop.catchUp();
    expect(laptop.engine.albums()).toEqual([]);
    expect(laptop.names()).toEqual(['a.jpg']);
  });

  describe('photos uploaded straight into an album', () => {
    const upload = async (title: string, color: string, filename: string) => {
      const { id } = await phone.engine.createAlbum(title);
      const { id: photo } = await phone.addInto(id, makeJpeg({ color }), filename);
      await phone.engine.queue.drain();
      await phone.saveState();
      return { album: id, photo };
    };

    it('stay out of Photos on another device too', async () => {
      await upload('Private', '#606060', 'a.jpg');
      laptop.storage.fetchCount = 0;
      await laptop.catchUp();

      const album = laptop.engine.albums()[0]!;
      expect(album).toMatchObject({ title: 'Private', photoCount: 1, onlyHereCount: 1 });
      expect(laptop.names({ album: album.id })).toEqual(['a.jpg']);
      expect(laptop.names()).toEqual([]);
      expect(laptop.storage.fetchCount).toBe(0);
    });

    it('leave Photos once the state file catches up, if the photo got there first', async () => {
      const { id } = await phone.engine.createAlbum('Private');
      await phone.addInto(id, makeJpeg({ color: '#666666' }), 'a.jpg');
      await phone.engine.queue.drain();

      // The phone has sent the photo but not yet saved which album it belongs to.
      await laptop.catchUp();
      expect(laptop.names()).toEqual(['a.jpg']);

      await phone.saveState();
      await laptop.catchUp();
      expect(laptop.names()).toEqual([]);
      expect(laptop.names({ album: laptop.engine.albums()[0]!.id })).toEqual(['a.jpg']);
    });

    it('stay out of Photos after a browser loses everything', async () => {
      await upload('Private', '#616161', 'a.jpg');
      await phone.wipeBrowser();
      await phone.signIn();

      const album = phone.engine.albums()[0]!;
      expect(phone.names({ album: album.id })).toEqual(['a.jpg']);
      expect(phone.names()).toEqual([]);
    });

    it('never appear in Photos partway through a rebuild', async () => {
      await upload('Private', '#626262', 'a.jpg');
      await laptop.engine.sync.pull();
      const insert = vi.spyOn(laptop.engine.store, 'insertPhotos');
      laptop.engine.library.startScan({ full: false });
      await laptop.engine.whenIdle();

      const inserted = insert.mock.calls.flatMap(([rows]) => rows);
      expect(inserted.map((r) => [r.filename, r.album_only])).toEqual([['a.jpg', true]]);
    });

    it('go to Trash on both devices when the album is deleted', async () => {
      const { album } = await upload('Gone', '#636363', 'a.jpg');
      await laptop.catchUp();

      await phone.engine.deleteAlbum(album);
      await phone.saveState();
      await laptop.catchUp();

      expect(laptop.engine.albums()).toEqual([]);
      expect(laptop.names()).toEqual([]);
      expect(laptop.names({ view: 'trash' })).toEqual(['a.jpg']);
    });

    it('move to Photos on both devices when removed from their album', async () => {
      const { album, photo } = await upload('Moved', '#646464', 'a.jpg');
      await laptop.catchUp();

      await phone.engine.removeFromAlbum(album, [photo]);
      await phone.saveState();
      await laptop.catchUp();

      expect(laptop.names()).toEqual(['a.jpg']);
      expect(idOn(laptop, 'a.jpg')).toBeDefined();
      expect(laptop.engine.photo(idOn(laptop, 'a.jpg')).albumOnly).toBe(false);
    });

    it('are read correctly from a state file saved before this existed', async () => {
      const a = await phone.stored(makeJpeg({ color: '#656565' }), 'a.jpg');
      await phone.engine.setFavorite([a], true);
      await phone.saveState();
      const file = await phone.storage.readState(CTX, null);
      const doc = await decodeDoc(file.changed ? file.file!.bytes : new Uint8Array());
      expect(Object.values(doc!.photos).every((record) => record.o === undefined)).toBe(true);

      await laptop.catchUp();
      expect(laptop.names()).toEqual(['a.jpg']);
    });
  });

  it('a permanent delete reaches the other device, and a scan cannot bring it back', async () => {
    const a = await phone.stored(makeJpeg({ color: '#666666' }), 'gone.jpg');
    await laptop.catchUp();
    expect(laptop.names()).toEqual(['gone.jpg']);

    await phone.engine.setTrashed([a], true);
    await phone.engine.deleteForever([a]);
    await phone.saveState();
    await laptop.catchUp();
    expect(laptop.names()).toEqual([]);
    expect(laptop.names({ view: 'trash' })).toEqual([]);

    laptop.engine.rescan();
    await laptop.engine.library.settled();
    expect(laptop.names()).toEqual([]);
  });

  it('a photo deleted and then added again comes back everywhere', async () => {
    const bytes = makeJpeg({ color: '#676767' });
    const a = await phone.stored(bytes, 'back.jpg');
    await phone.engine.setTrashed([a], true);
    await phone.engine.deleteForever([a]);
    await phone.saveState();
    await new Promise((r) => setTimeout(r, 5));

    await phone.stored(bytes, 'back.jpg');
    await phone.engine.setFavorite([idOn(phone, 'back.jpg')], true);
    await phone.saveState();
    await laptop.catchUp();
    expect(laptop.names()).toEqual(['back.jpg']);
  });

  it('does not let another device\'s old deletion remove a file still being sent', async () => {
    const bytes = makeJpeg({ color: '#686868' });
    const a = await phone.stored(bytes, 'x.jpg');
    await phone.engine.setTrashed([a], true);
    await phone.engine.deleteForever([a]);
    await phone.saveState();

    laptop.storage.failNextPut = new Error('still sending');
    const id = await laptop.addOk(bytes, 'x.jpg');
    await laptop.engine.sync.pull();
    expect(laptop.engine.photo(id)).toBeTruthy();
    await laptop.engine.queue.drain();
  });

  it('survives a damaged state file, and repairs it', async () => {
    const a = await phone.stored(makeJpeg({ color: '#777777' }), 'a.jpg');
    await phone.engine.setFavorite([a], true);
    await phone.saveState();

    await laptop.storage.writeState(CTX, new Uint8Array([1, 2, 3, 4]), null);
    await laptop.engine.sync.pull();
    expect(await decodeDoc(new Uint8Array([1, 2, 3, 4]))).toBeNull();

    await phone.engine.sync.pull();
    expect(phone.engine.photo(a).favorite).toBe(true);
    expect(phone.engine.sync.hasUnsavedChanges).toBe(true);
    await phone.saveState();
    const read = await phone.storage.readState(CTX, null);
    expect(read.changed && read.file ? await decodeDoc(read.file.bytes) : null).not.toBeNull();
  });

  it('only downloads the state when it has changed', async () => {
    await phone.engine.createAlbum('One');
    await phone.saveState();
    await laptop.engine.sync.pull();
    const reads: boolean[] = [];
    const original = laptop.storage.readState.bind(laptop.storage);
    laptop.storage.readState = (async (ctx, known) => {
      const result = await original(ctx, known);
      reads.push(result.changed);
      return result;
    }) as typeof laptop.storage.readState;
    await laptop.engine.sync.pull();
    expect(reads).toEqual([false]);
  });

  it('remembers unsaved changes across a reload, and saves them next time', async () => {
    const a = await phone.stored(makeJpeg({ color: '#888888' }), 'a.jpg');
    await phone.engine.setFavorite([a], true);
    await phone.reload();
    expect(phone.engine.sync.hasUnsavedChanges).toBe(true);
    await phone.saveState();
    await laptop.catchUp();
    expect(laptop.engine.photo(idOn(laptop, 'a.jpg')).favorite).toBe(true);
  });

  it('tells the screen when another device changed something', async () => {
    const a = await phone.stored(makeJpeg({ color: '#999999' }), 'a.jpg');
    await laptop.catchUp();
    const before = laptop.engine.uploadStatus().revision;
    await phone.engine.setFavorite([a], true);
    await phone.saveState();
    await laptop.catchUp();
    expect(laptop.engine.uploadStatus().revision).toBeGreaterThan(before);
  });

  it('writes nothing at all when nothing has changed', async () => {
    await phone.engine.whenIdle();
    const before = phone.storage.stateWrites;
    await phone.saveState();
    expect(phone.storage.stateWrites).toBe(before);
  });
});
