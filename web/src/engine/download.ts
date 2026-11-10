import { downloadZip } from 'client-zip';
import { androidBridge, saveThroughApp } from './android';
import type { Engine } from './index';
import { saveThroughWorker } from './mediaWorker';
import type { PhotoRow } from './store';

/** Past this it is worth asking where to save, so the file can go straight to disk instead of through memory. */
const STREAM_TO_DISK_BYTES = 200 * 1024 * 1024;

type SavePicker = (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;

const savePicker = (): SavePicker | null => (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker ?? null;

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Long enough for the browser to have started reading it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function toStream(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/** Stops two photos with one name overwriting each other in the zip. */
export function uniqueNamer() {
  const used = new Set<string>();
  return (filename: string): string => {
    const dot = filename.lastIndexOf('.');
    const [base, ext] = dot > 0 ? [filename.slice(0, dot), filename.slice(dot)] : [filename, ''];
    let name = filename;
    for (let n = 1; used.has(name.toLowerCase()); n++) name = `${base} (${n})${ext}`;
    used.add(name.toLowerCase());
    return name;
  };
}

/** Photos are already compressed, so a zip that only stores them costs nothing and stays fast. */
export function zipOf(engine: Engine, photos: PhotoRow[]): Response {
  const name = uniqueNamer();
  async function* entries() {
    for (const photo of photos) {
      yield { name: name(photo.filename), input: toStream(await engine.openOriginalStream(photo.id)), size: photo.size };
    }
  }
  return downloadZip(entries());
}

/**
 * Saves originals to the person's device, straight from Telegram.
 *
 * Has to be called directly from the click: browsers only allow the save dialog during one, which
 * is why the dialog is opened before anything else is awaited.
 */
export async function downloadOriginals(engine: Engine, ids: number[]): Promise<void> {
  const photos = engine.photosForDownload(ids);
  const single = photos.length === 1 ? photos[0]! : null;
  const filename = single ? single.filename : `Tele-Photo-${photos.length}-photos.zip`;
  const total = photos.reduce((sum, p) => sum + p.size, 0);

  const picker = total > STREAM_TO_DISK_BYTES ? savePicker() : null;
  if (picker) {
    let handle;
    try {
      handle = await picker({ suggestedName: filename });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      throw err;
    }
    const writable = await handle.createWritable();
    const body = single ? toStream(await engine.openOriginalStream(single.id)) : zipOf(engine, photos).body!;
    await body.pipeTo(writable);
    return;
  }

  // No save dialog in this browser. Gathering this much into a Blob first could easily fail, so it goes straight to disk another way.
  if (total > STREAM_TO_DISK_BYTES) {
    const open = async () => (single ? toStream(await engine.openOriginalStream(single.id)) : zipOf(engine, photos).body!);
    if (await saveThroughWorker(filename, single ? single.size : null, open)) return;
  }

  const blob = single ? await engine.original(single.id) : await zipOf(engine, photos).blob();
  const bridge = androidBridge();
  if (bridge) await saveThroughApp(bridge, blob, filename);
  else saveBlob(blob, filename);
}
