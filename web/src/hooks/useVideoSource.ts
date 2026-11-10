import { useEffect, useState } from 'react';
import { getEngine } from '@/api';
import { openVideo } from '@/engine/mediaWorker';

/** A video being left fades out rather than vanishing, and may still ask for more until it has gone. */
const CLOSE_DELAY_MS = 1000;

export type VideoSource = { state: 'opening' | 'unavailable'; url: null } | { state: 'ready'; url: string };

/** Where a <video> can stream this file from. `unavailable` means this browser has no way to stream it. */
export function useVideoSource(id: number | null): VideoSource {
  const [source, setSource] = useState<{ id: number; url: string | null } | null>(null);

  useEffect(() => {
    if (id === null) return;
    let close: (() => void) | undefined;
    let cancelled = false;
    void getEngine()
      .then((engine) => openVideo(engine, id))
      .catch(() => null)
      .then((opened) => {
        if (cancelled) {
          opened?.close();
          return;
        }
        close = opened?.close;
        setSource({ id, url: opened?.url ?? null });
      });
    return () => {
      cancelled = true;
      if (close) setTimeout(close, CLOSE_DELAY_MS);
    };
  }, [id]);

  // The right video only: for one render after `id` changes, `source` is still the last one's.
  if (!source || source.id !== id) return { state: 'opening', url: null };
  return source.url ? { state: 'ready', url: source.url } : { state: 'unavailable', url: null };
}
