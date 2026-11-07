import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { api, autoBackup, getEngine } from '@/api';
import type { Engine } from '@/engine/index';
import { uploader } from '@/lib/uploads';

export function useLocalUploads() {
  return useSyncExternalStore(uploader.subscribe, uploader.snapshot);
}

/** Watches the upload queue, and refreshes the grid as photos move through it. */
export function useUploadStatus() {
  const queryClient = useQueryClient();
  const local = useLocalUploads();
  const sending = local.some((e) => e.stage === 'waiting' || e.stage === 'sending');

  const query = useQuery({
    queryKey: ['upload-status'],
    queryFn: api.uploadStatus,
    refetchInterval: (q) => {
      const data = q.state.data;
      return sending || data?.scan.running || (data?.items.some((i) => i.status !== 'failed') ?? false) ? 1200 : 20_000;
    },
  });

  const stats = query.data?.stats;
  const scan = query.data?.scan;
  // `revision` covers changes from another device, like a favorite, that move none of these counts.
  const signature = `${stats?.count}/${stats?.pending}/${stats?.failed}/${stats?.trash}/${scan?.added}/${scan?.running}/${query.data?.revision}`;
  const previous = useRef(signature);
  useEffect(() => {
    if (previous.current !== signature) {
      previous.current = signature;
      void queryClient.invalidateQueries({ queryKey: ['photos'] });
      void queryClient.invalidateQueries({ queryKey: ['albums'] });
      void queryClient.invalidateQueries({ queryKey: ['photo'] });
    }
  }, [signature, queryClient]);

  useEffect(() => {
    uploader.onReceived = () => {
      void queryClient.invalidateQueries({ queryKey: ['upload-status'] });
      void queryClient.invalidateQueries({ queryKey: ['photos'] });
      // A file already stored moves none of the counts above, but can still join an album.
      void queryClient.invalidateQueries({ queryKey: ['albums'] });
    };
    return () => {
      uploader.onReceived = null;
    };
  }, [queryClient]);

  useEffect(() => {
    let engine: Engine | null = null;
    void getEngine().then((e) => {
      engine = e;
    });
    const warn = (event: BeforeUnloadEvent) => {
      // Nothing carries on after the tab closes any more, so this now covers the whole journey to Telegram.
      if (uploader.isBusy || engine?.hasUploadsInProgress) event.preventDefault();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') engine?.refresh();
      else void engine?.sync.flush();
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // A phone suspends a page when its screen locks, which would stall an upload until it woke again.
  const uploading = sending || (query.data?.stats.pending ?? 0) > 0;
  useEffect(() => {
    // The Android app keeps itself running without the screen, which is the whole point of it.
    if (!uploading || !navigator.wakeLock || autoBackup.available) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = () => {
      if (document.visibilityState !== 'visible') return;
      void navigator.wakeLock.request('screen').then(
        (sentinel) => {
          if (cancelled) void sentinel.release();
          else lock = sentinel;
        },
        () => undefined,
      );
    };
    acquire();
    // The browser drops it whenever the tab is hidden, so it has to be asked for again on return.
    document.addEventListener('visibilitychange', acquire);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release();
    };
  }, [uploading]);

  return query.data;
}
