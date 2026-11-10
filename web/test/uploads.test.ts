import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEngine } from '../src/api';
import { MAX_PHOTO_BYTES, uploader } from '../src/lib/uploads';
import { Device, makeJpeg } from './helpers';

vi.mock('../src/api', async () => {
  const { UserFacingError } = await import('../src/engine/types');
  return { ApiError: UserFacingError, getEngine: vi.fn() };
});

describe('retrying selected uploads', () => {
  let device: Device;
  beforeEach(async () => {
    device = await new Device().open();
    await device.signIn();
    vi.mocked(getEngine).mockResolvedValue(device.engine);
  });
  afterEach(async () => {
    await vi.waitFor(() => expect(uploader.isBusy).toBe(false));
    uploader.clearSettled(() => true);
    await device.close();
    vi.restoreAllMocks();
  });

  it('takes videos, recognising the ones a browser gives no type for by name', async () => {
    vi.mocked(getEngine).mockRejectedValue(new Error('Not now'));
    const named = new File(['x'], 'holiday.mkv');
    const typed = new File(['x'], 'clip', { type: 'video/mp4' });
    const other = new File(['x'], 'notes.txt', { type: 'text/plain' });
    expect(uploader.add([named, typed, other])).toEqual({ added: 2, skipped: 1 });
    await vi.waitFor(() => expect(uploader.isBusy).toBe(false));
  });

  it('refuses a photo over the Telegram limit straight away, but lets a video that size go on to be split', async () => {
    vi.mocked(getEngine).mockRejectedValue(new Error('Not now'));
    const sized = (file: File) => Object.defineProperty(file, 'size', { value: MAX_PHOTO_BYTES + 1 }) as File;
    uploader.add([sized(new File(['x'], 'huge.jpg', { type: 'image/jpeg' })), sized(new File(['x'], 'huge.mp4', { type: 'video/mp4' }))]);
    await vi.waitFor(() => expect(uploader.isBusy).toBe(false));
    const [photo, video] = uploader.snapshot();
    expect(photo).toMatchObject({ stage: 'error', file: null });
    expect(photo!.error).toMatch(/1\.95 GB/);
    // It got as far as asking the engine, which is what the mock turned away.
    expect(video).toMatchObject({ stage: 'error', error: 'Not now' });
  });

  it('retries all 50 selected files after preparation fails', async () => {
    const files = Array.from({ length: 50 }, (_, i) =>
      new File([makeJpeg({ color: `local-${i}` }) as BlobPart], `${i}.jpg`, { type: 'image/jpeg' }));
    vi.mocked(getEngine).mockRejectedValue(new Error('Temporarily unavailable'));
    uploader.add(files);
    await vi.waitFor(() => expect(uploader.isBusy).toBe(false));
    expect(uploader.snapshot()).toHaveLength(50);
    expect(uploader.snapshot().every((entry) => entry.stage === 'error' && entry.file !== null)).toBe(true);

    vi.mocked(getEngine).mockResolvedValue(device.engine);
    for (const entry of uploader.snapshot()) uploader.retry(entry.key);
    await vi.waitFor(() => expect(uploader.isBusy).toBe(false));
    await device.engine.queue.drain();
    expect(uploader.snapshot().every((entry) => entry.stage === 'received' && entry.file === null)).toBe(true);
    expect(device.engine.store.libraryStats()).toMatchObject({ count: 50, failed: 0, pending: 0 });
  });

  it('reattaches an original selected by Retry to the failed upload after a reload', async () => {
    const file = new File([makeJpeg() as BlobPart], 'original.jpg', { type: 'image/jpeg' });
    device.storage.failNextPut = new Error('offline');
    uploader.add([file]);
    await vi.waitFor(() => expect(uploader.isBusy).toBe(false));
    await device.engine.queue.drain();
    const id = uploader.snapshot()[0]!.photoId!;
    uploader.clearSettled(() => true);
    await device.reload();
    vi.mocked(getEngine).mockResolvedValue(device.engine);
    expect(device.engine.uploadStatus().items[0]).toMatchObject({ id, needsFile: true });

    uploader.add([file], null, { retryOnly: true });
    await vi.waitFor(() => expect(uploader.isBusy).toBe(false));
    await device.engine.queue.drain();
    expect(uploader.snapshot()[0]).toMatchObject({ stage: 'received', photoId: id });
    expect(device.engine.photo(id).status).toBe('stored');
    expect(device.engine.store.allPhotos()).toHaveLength(1);
  });
});
