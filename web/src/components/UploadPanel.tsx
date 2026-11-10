import { LiquiGlass } from '@liqui-design/glass';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, CloudUpload, Copy, RotateCw, TriangleAlert, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ApiError, api, autoBackup, type QueueItem, type UploadStatus } from '@/api';
import { Progress, ProgressTrack } from '@/components/ui/progress';
import { useToast } from '@/components/ui/toast';
import { useLocalUploads } from '@/hooks/useUploadStatus';
import { formatBytes } from '@/lib/format';
import { QUICK } from '@/lib/motion';
import { ACCEPTED_FILES, type LocalUpload, uploader } from '@/lib/uploads';

const MAX_ROWS = 60;

type Tone = 'active' | 'done' | 'error' | 'info';

interface Row {
  key: string;
  filename: string;
  size: number;
  tone: Tone;
  label: string;
  progress: number | null;
  onRetry?: () => void;
  needsFile?: boolean;
  onDismiss?: () => void;
}

function describeQueued(item: QueueItem): Pick<Row, 'tone' | 'label' | 'progress'> {
  if (item.status === 'failed') return { tone: 'error', label: item.error ?? 'Could not save to Telegram.', progress: null };
  if (item.status === 'uploading') {
    return { tone: 'active', label: `Saving to Telegram · ${Math.round((item.progress ?? 0) * 100)}%`, progress: item.progress ?? 0 };
  }
  if (item.nextAttemptAt) {
    const minutes = Math.max(1, Math.ceil((item.nextAttemptAt - Date.now()) / 60_000));
    return { tone: 'active', label: item.error ? `Will retry in about ${minutes} min` : `Telegram asked us to wait about ${minutes} min`, progress: null };
  }
  return { tone: 'active', label: 'Waiting to go to Telegram', progress: null };
}

export function UploadPanel({ status }: { status: UploadStatus | undefined }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const local = useLocalUploads();
  const [collapsed, setCollapsed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    for (const key of ['upload-status', 'photos', 'photo', 'albums']) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  }, [queryClient]);

  const fail = useCallback((err: unknown) => {
    toast.add({
      title: 'Could not update the upload',
      description: err instanceof Error ? err.message : 'Please try again.',
      type: 'error',
      ...(err instanceof ApiError && err.code === 'FILE_NEEDED'
        ? { actionProps: { children: 'Choose files', onClick: () => fileInput.current?.click() } }
        : {}),
    });
    refresh();
  }, [refresh, toast]);

  const retryQueued = useCallback((items: QueueItem[]) => {
    const ready = items.filter((item) => !item.needsFile);
    if (ready.length > 0) void api.retryUploads(ready.map((item) => item.id)).then(refresh, fail);
    if (!items.some((item) => item.needsFile)) return;
    // Auto backup can read the file again by itself, so there is no need to ask for it.
    if (autoBackup.handlesRetries()) void autoBackup.retryNow().then(refresh, fail);
    // Open from the click itself so browsers allow the file picker, including on phones.
    else fileInput.current?.click();
  }, [refresh, fail]);

  const queued = useMemo(() => new Map((status?.items ?? []).map((item) => [item.id, item])), [status]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const claimed = new Set<number>();
    const cancelQueued = (id: number) => () => void api.cancelUpload(id).then(refresh, fail);
    const queuedRetry = (item: QueueItem) => ({
      onRetry: item.status === 'failed' ? () => retryQueued([item]) : undefined,
      needsFile: item.status === 'failed' && item.needsFile,
    });

    for (const entry of local as LocalUpload[]) {
      const base = { key: `l${entry.key}`, filename: entry.filename, size: entry.size, onDismiss: () => uploader.dismiss(entry.key) };
      if (entry.photoId !== null) claimed.add(entry.photoId);
      const remote = entry.photoId !== null ? queued.get(entry.photoId) : undefined;

      if (entry.stage === 'waiting') out.push({ ...base, tone: 'active', label: 'Waiting', progress: null, onDismiss: undefined });
      else if (entry.stage === 'sending') {
        out.push({ ...base, tone: 'active', label: `Getting ready · ${Math.round(entry.progress * 100)}%`, progress: entry.progress, onDismiss: undefined });
      } else if (entry.stage === 'error') {
        out.push({ ...base, tone: 'error', label: entry.error ?? 'Failed.', progress: null, onRetry: entry.file ? () => uploader.retry(entry.key) : undefined });
      } else if (entry.stage === 'duplicate') {
        out.push({ ...base, tone: 'info', label: entry.albumId !== null ? 'Already stored, so it was just added to the album' : 'Already in your library', progress: null });
      } else if (entry.stage === 'restored') {
        out.push({ ...base, tone: 'info', label: 'Back from Trash', progress: null });
      } else if (remote) {
        out.push({
          ...base,
          ...describeQueued(remote),
          ...queuedRetry(remote),
          onDismiss: remote.status === 'uploading' ? undefined : cancelQueued(remote.id),
        });
      } else {
        out.push({ ...base, tone: 'done', label: 'Saved to Telegram', progress: null });
      }
    }

    // What is left of the queue after a reload, when this list has started empty.
    for (const item of status?.items ?? []) {
      if (claimed.has(item.id)) continue;
      out.push({
        key: `s${item.id}`,
        filename: item.filename,
        size: item.size,
        ...describeQueued(item),
        ...queuedRetry(item),
        onDismiss: item.status === 'uploading' ? undefined : cancelQueued(item.id),
      });
    }

    const rank: Record<Tone, number> = { error: 0, active: 1, done: 2, info: 3 };
    return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
  }, [local, queued, status, refresh, fail, retryQueued]);

  const retryable = rows.filter((row) => row.onRetry).length;
  const needsFiles = rows.some((row) => row.needsFile);
  const retryAll = () => {
    for (const entry of local) {
      if (entry.stage === 'error' && entry.file) uploader.retry(entry.key);
    }
    retryQueued((status?.items ?? []).filter((item) => item.status === 'failed'));
  };

  const scanning = status?.scan.running ?? false;
  const visible = rows.length > 0 || scanning;

  const active = rows.filter((r) => r.tone === 'active').length;
  const failed = rows.filter((r) => r.tone === 'error').length;
  const finished = rows.length - active - failed;

  const title = scanning
    ? `Restoring from Telegram · ${(status?.scan.added ?? 0).toLocaleString()} found`
    : active > 0
      ? `Uploading ${active.toLocaleString()} ${active === 1 ? 'file' : 'files'}`
      : failed > 0
        ? `${failed.toLocaleString()} ${failed === 1 ? 'file needs' : 'files need'} attention`
        : `${finished.toLocaleString()} ${finished === 1 ? 'file' : 'files'} done`;

  return (
    <AnimatePresence>
      {visible ? (
    <motion.div
      key="panel"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24, transition: QUICK }}
      className="fixed right-3 bottom-[112px] z-40 w-[min(380px,calc(100vw-1.5rem))] min-[720px]:right-5 min-[1240px]:bottom-5"
    >
      {/*
        Frost, not refraction: this panel changes height as it opens and closes, and a refracting
        surface rebuilds its displacement map on every frame of that. At this much tint the
        refraction was barely visible anyway.
      */}
      <LiquiGlass material="frost" radius={22} elevated frost={1} blur={6} className="lq-solid" contentClassName="flex flex-col">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label="Choose the original files to retry"
          accept={ACCEPTED_FILES}
          onChange={(event) => {
            uploader.add([...(event.target.files ?? [])], null, { retryOnly: true });
            event.target.value = '';
          }}
        />
        <div className="flex items-center gap-2 px-4 py-3" aria-live="polite">
          {failed > 0 && active === 0 ? (
            <TriangleAlert className="size-[18px] flex-none text-[var(--lq-danger)]" aria-hidden="true" />
          ) : active > 0 || scanning ? (
            <CloudUpload className="shimmer size-[18px] flex-none text-[var(--lq-accent)]" aria-hidden="true" />
          ) : (
            <Check className="size-[18px] flex-none text-emerald-500" aria-hidden="true" />
          )}
          <h2 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{title}</h2>
          <button type="button" aria-label={collapsed ? 'Show uploads' : 'Hide uploads'} className="grid size-7 cursor-pointer place-items-center rounded-full hover:bg-[var(--lq-highlight)]" onClick={() => setCollapsed((c) => !c)}>
            <motion.span className="block" initial={false} animate={{ rotate: collapsed ? 180 : 0 }}>
              <ChevronDown className="size-4" aria-hidden="true" />
            </motion.span>
          </button>
          {active === 0 && failed === 0 && !scanning ? (
            <button
              type="button"
              aria-label="Close"
              className="grid size-7 cursor-pointer place-items-center rounded-full hover:bg-[var(--lq-highlight)]"
              onClick={() => uploader.clearSettled(() => true)}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <AnimatePresence initial={false}>
        {collapsed ? null : (
          <motion.div key="list" className="overflow-hidden" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0, transition: { duration: 0.2, ease: [0.2, 0.8, 0.3, 1] } }}>
            <ul className="max-h-[38vh] overflow-y-auto border-t border-[var(--app-line)]">
              {rows.slice(0, MAX_ROWS).map((row) => (
                <li key={row.key} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{row.filename}</p>
                      <span className="flex-none text-[11px] text-[var(--lq-text-dim)]">{formatBytes(row.size)}</span>
                    </div>
                    <p className={`mt-0.5 flex items-center gap-1 text-[12px] ${row.tone === 'error' ? 'font-medium text-[var(--lq-danger-text)]' : 'text-[var(--lq-text-dim)]'}`}>
                      {row.tone === 'done' ? <Check className="size-3 flex-none text-emerald-500" aria-hidden="true" /> : null}
                      {row.tone === 'info' ? <Copy className="size-3 flex-none" aria-hidden="true" /> : null}
                      <span className="min-w-0">{row.label}</span>
                    </p>
                    {row.progress !== null ? (
                      <Progress value={Math.round(row.progress * 100)} aria-label={`${row.filename} progress`} className="mt-1.5">
                        <ProgressTrack className="h-1.5" glass={{ material: 'clear' }} />
                      </Progress>
                    ) : null}
                  </div>
                  {row.onRetry ? (
                    <button type="button" aria-label={`Retry ${row.filename}`} title={row.needsFile ? 'Choose the original file to retry' : 'Retry upload'} className="grid size-7 flex-none cursor-pointer place-items-center rounded-full hover:bg-[var(--lq-highlight)]" onClick={row.onRetry}>
                      <RotateCw className="size-3.5" aria-hidden="true" />
                    </button>
                  ) : null}
                  {row.onDismiss && row.tone === 'error' ? (
                    <button type="button" aria-label={`Remove ${row.filename}`} className="grid size-7 flex-none cursor-pointer place-items-center rounded-full hover:bg-[var(--lq-highlight)]" onClick={row.onDismiss}>
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  ) : null}
                </li>
              ))}
              {rows.length > MAX_ROWS ? (
                <li className="px-4 py-2 text-center text-[12px] text-[var(--lq-text-dim)]">and {(rows.length - MAX_ROWS).toLocaleString()} more</li>
              ) : null}
            </ul>
            {retryable > 1 || needsFiles ? (
              <div className="border-t border-[var(--app-line)] px-4 py-2 text-[11.5px] text-[var(--lq-text-dim)]">
                {needsFiles && !autoBackup.handlesRetries() ? <p>Select the original files again to retry. You can select the whole batch; saved files will be skipped.</p> : null}
                {retryable > 1 ? (
                  <button type="button" className="mt-1 cursor-pointer font-semibold text-[var(--lq-accent)]" onClick={retryAll}>Retry all failed uploads</button>
                ) : null}
              </div>
            ) : null}
            {active > 0 ? (
              <p className="border-t border-[var(--app-line)] px-4 py-2 text-[11.5px] text-[var(--lq-text-dim)]">
                {autoBackup.available ? 'Your files go straight to Telegram from this phone.' : 'Keep this tab open until everything has reached Telegram. Your files go straight there from this device.'}
              </p>
            ) : null}
          </motion.div>
        )}
        </AnimatePresence>
      </LiquiGlass>
    </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
