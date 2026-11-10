import type { Engine } from './index';

const WORKER_URL = '/media-sw.js';
const ROUTE = '/__media/';
/** Well inside the 30 seconds of quiet after which browsers stop a worker. */
const PING_MS = 10_000;
const CONTROL_WAIT_MS = 3000;
/** How long a browser gets to start a download through the worker before it is assumed not to. */
const DOWNLOAD_START_WAIT_MS = 15_000;

export type WorkerRequest =
  | { type: 'open'; token: string }
  | { type: 'read'; token: string; start: number; end: number }
  | { type: 'next'; token: string }
  | { type: 'cancel'; token: string };

export interface WorkerReply {
  missing?: true;
  error?: string;
  done?: true;
  bytes?: ArrayBuffer;
  size?: number | null;
  mime?: string;
  filename?: string;
  download?: boolean;
}

interface DownloadSource {
  kind: 'download';
  filename: string;
  size: number | null;
  open: () => Promise<ReadableStream<Uint8Array>>;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  onOpened: () => void;
  onFinished: (err?: unknown) => void;
}

type Source = { kind: 'video'; engine: Engine; id: number } | DownloadSource;

/** The only way to reach a file through the worker is a random token this tab handed out. */
const sources = new Map<string, Source>();
let pinger: ReturnType<typeof setInterval> | null = null;

function addSource(source: Source): string {
  const token = crypto.randomUUID();
  sources.set(token, source);
  pinger ??= setInterval(() => navigator.serviceWorker?.controller?.postMessage('ping'), PING_MS);
  return token;
}

function dropSource(token: string): void {
  sources.delete(token);
  if (sources.size === 0 && pinger) {
    clearInterval(pinger);
    pinger = null;
  }
}

/** A copy of exactly these bytes, because a chunk is often a view into something much larger. */
function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function nextChunk(token: string, source: DownloadSource): Promise<WorkerReply> {
  source.reader ??= (await source.open()).getReader();
  const { done, value } = await source.reader.read();
  if (done) {
    dropSource(token);
    source.onFinished();
    return { done: true };
  }
  return { bytes: ownBuffer(value) };
}

/** Answers one question from the worker. */
export async function answerWorker(request: WorkerRequest): Promise<WorkerReply> {
  const source = sources.get(request.token);
  if (!source) return { missing: true };
  try {
    switch (request.type) {
      case 'open':
        if (source.kind === 'video') return { ...source.engine.fileInfo(source.id), download: false };
        source.onOpened();
        return { size: source.size, filename: source.filename, download: true };
      case 'read':
        if (source.kind !== 'video') return { error: 'This is a download' };
        return { bytes: ownBuffer(await source.engine.readRange(source.id, request.start, request.end)) };
      case 'next':
        if (source.kind !== 'download') return { error: 'This is a video' };
        return await nextChunk(request.token, source);
      case 'cancel':
        if (source.kind === 'download') {
          dropSource(request.token);
          await source.reader?.cancel().catch(() => undefined);
          source.onFinished();
        }
        return { done: true };
    }
  } catch (err) {
    if (source.kind === 'download') {
      dropSource(request.token);
      source.onFinished(err);
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function onWorkerMessage(event: MessageEvent<WorkerRequest>): void {
  void answerWorker(event.data).then((reply) => {
    event.ports[0]?.postMessage(reply, reply.bytes ? [reply.bytes] : []);
  });
}

function waitForControl(workers: ServiceWorkerContainer): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, CONTROL_WAIT_MS);
    workers.addEventListener('controllerchange', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

let starting: Promise<boolean> | null = null;

/**
 * False where there is no worker to be had: Firefox's private windows, a page that is not on HTTPS,
 * or a page opened with a hard reload, which browsers keep out of a worker's hands by design.
 */
function workerReady(): Promise<boolean> {
  starting ??= (async () => {
    const workers = navigator.serviceWorker;
    if (!workers) return false;
    try {
      workers.addEventListener('message', onWorkerMessage);
      workers.startMessages();
      await workers.register(WORKER_URL);
      await workers.ready;
      if (!workers.controller) await waitForControl(workers);
      return workers.controller !== null;
    } catch {
      return false;
    }
  })();
  return starting;
}

/** A URL a <video> can play this file from, seeking anywhere in it, or null if this browser cannot do that. */
export async function openVideo(engine: Engine, id: number): Promise<{ url: string; close: () => void } | null> {
  if (!(await workerReady())) return null;
  const token = addSource({ kind: 'video', engine, id });
  return { url: `${ROUTE}${token}`, close: () => dropSource(token) };
}

/**
 * Saves a stream to the browser's downloads straight to disk, for browsers with no save dialog.
 * Resolves false if nothing was started, so the caller can fall back, and otherwise when it ends.
 */
export async function saveThroughWorker(filename: string, size: number | null, open: () => Promise<ReadableStream<Uint8Array>>): Promise<boolean> {
  if (!(await workerReady())) return false;
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    const token = addSource({
      kind: 'download',
      filename,
      size,
      open,
      reader: null,
      onOpened: () => clearTimeout(timer),
      onFinished: (err) => {
        frame.remove();
        if (err) reject(err);
        else resolve(true);
      },
    });
    const timer = setTimeout(() => {
      dropSource(token);
      frame.remove();
      resolve(false);
    }, DOWNLOAD_START_WAIT_MS);
    frame.src = `${ROUTE}${token}`;
    document.body.append(frame);
  });
}
