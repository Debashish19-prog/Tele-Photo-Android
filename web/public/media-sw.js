/**
 * Lets a <video> play, and a browser save, a file that only exists as pieces in Telegram.
 *
 * Both of those can only read from a URL. So the page hands out a private URL, and this worker
 * answers it the way a web server would, asking the page for each stretch of bytes as they are
 * wanted. Nothing is kept here: the page holds the Telegram connection, and a worker that the
 * browser stops and restarts carries on as if nothing had happened.
 */

const ROUTE = '/__media/';
/** Telegram's own block size. Reads end on a multiple of it, so that they line up after a seek. */
const BLOCK_BYTES = 512 * 1024;
/**
 * How much to ask the page for at once. It starts small because a player often reads a few bytes
 * here and there as it looks around a file, and doubles for one that keeps on reading. The page
 * may answer with less, in which case this asks again from there.
 */
const FIRST_READ_BYTES = 2 * BLOCK_BYTES;
const MOST_READ_BYTES = 4 * BLOCK_BYTES;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// The page pings while a stream is open, because an idle worker gets stopped mid-stream. Arriving is all a ping has to do.
self.addEventListener('message', () => undefined);

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(ROUTE)) return;
  event.respondWith(respond(event, url.pathname.slice(ROUTE.length)));
});

function ask(client, message) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      channel.port1.close();
      resolve(event.data);
    };
    client.postMessage(message, [channel.port2]);
  });
}

/** A download arrives as a navigation, which belongs to no page yet, so whichever page issued the token answers for it. */
async function findOwner(event, token) {
  const direct = event.clientId ? await self.clients.get(event.clientId) : null;
  const pages = direct ? [direct] : await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return Promise.any(
    pages.map(async (client) => {
      const info = await ask(client, { type: 'open', token });
      if (info.missing || info.error) throw new Error('Not this page');
      return { client, info };
    }),
  );
}

async function respond(event, token) {
  let owner;
  try {
    owner = await findOwner(event, token);
  } catch {
    return new Response(null, { status: 404 });
  }
  return owner.info.download ? downloadResponse(owner.client, token, owner.info) : rangeResponse(owner.client, token, owner.info, event.request.headers.get('range'));
}

/** Returns the bytes wanted as [start, end), null for the whole file, or 'invalid' for a range the file cannot satisfy. */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const length = Number(match[2]);
    return length === 0 ? 'invalid' : { start: Math.max(0, size - length), end: size };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) + 1 : size;
  return start >= size || end <= start ? 'invalid' : { start, end: Math.min(end, size) };
}

function rangeResponse(client, token, info, rangeHeader) {
  const range = parseRange(rangeHeader, info.size);
  const common = { 'Content-Type': info.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (range === 'invalid') return new Response(null, { status: 416, headers: { ...common, 'Content-Range': `bytes */${info.size}` } });

  const { start, end } = range ?? { start: 0, end: info.size };
  let at = start;
  let wanted = FIRST_READ_BYTES;
  // Pulled on demand, so a video that is paused, or seeks elsewhere, stops costing downloads.
  const body = new ReadableStream({
    async pull(controller) {
      const aligned = Math.floor((at + wanted) / BLOCK_BYTES) * BLOCK_BYTES;
      const reply = await ask(client, { type: 'read', token, start: at, end: Math.min(end, aligned > at ? aligned : at + wanted) });
      wanted = Math.min(wanted * 2, MOST_READ_BYTES);
      if (!reply.bytes?.byteLength) {
        controller.error(new Error(reply.error ?? 'The file ended early'));
        return;
      }
      controller.enqueue(new Uint8Array(reply.bytes));
      at += reply.bytes.byteLength;
      if (at >= end) controller.close();
    },
  });
  const headers = { ...common, 'Content-Length': String(end - start) };
  if (!range) return new Response(body, { status: 200, headers });
  return new Response(body, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end - 1}/${info.size}` } });
}

function downloadResponse(client, token, info) {
  const body = new ReadableStream({
    async pull(controller) {
      const reply = await ask(client, { type: 'next', token });
      if (reply.error) controller.error(new Error(reply.error));
      else if (reply.done) controller.close();
      else controller.enqueue(new Uint8Array(reply.bytes));
    },
    cancel() {
      client.postMessage({ type: 'cancel', token });
    },
  });
  const name = encodeURIComponent(info.filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
  if (info.size !== null) headers['Content-Length'] = String(info.size);
  return new Response(body, { status: 200, headers });
}
