import { Check, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type VerifyResult } from '@/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions, DialogContent, DialogDismiss, DialogTitle } from '@/components/ui/dialog';
import { formatBytes } from '@/lib/format';

/** Five sample files, plus the file that holds albums and favorites. */
const STEPS = 8;

/**
 * The one check automated tests cannot do: send real files through this account's real Telegram,
 * get them back, and compare them. It leaves nothing behind.
 */
export function StorageCheckDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [results, setResults] = useState<VerifyResult[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setResults([]);
    setError(null);
  }, [open]);

  const start = () => {
    setResults([]);
    setError(null);
    setRunning(true);
    void api
      .verifyStorage((result) => setResults((current) => [...current, result]))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'The check could not run.'))
      .finally(() => setRunning(false));
  };

  const finished = !running && results.length > 0;
  const failed = results.filter((r) => !r.pass).length;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !running && onClose()}>
      <DialogContent className="lq-solid" glass={{ frost: 1, blur: 6 }}>
        <DialogTitle>Check Telegram storage</DialogTitle>
        <p className="mt-1 text-[13.5px] text-[var(--lq-text-dim)]">
          Sends a few generated files to your library channel, downloads them again, confirms every byte matches, and deletes them. It takes a minute or so and uses about 20 MB.
        </p>
        {results.length > 0 || running ? (
          <ul className="mt-3 flex flex-col gap-2">
            {results.map((result) => (
              <li key={result.name} className="flex items-start gap-2 text-[13px]" data-check-result={result.pass ? 'pass' : 'fail'}>
                {result.pass ? <Check className="mt-0.5 size-4 flex-none text-emerald-500" aria-hidden="true" /> : <TriangleAlert className="mt-0.5 size-4 flex-none text-[var(--lq-danger)]" aria-hidden="true" />}
                <span className="min-w-0">
                  <span className="font-semibold">{result.name}</span>
                  {result.size !== null ? <span className="text-[var(--lq-text-dim)]"> · {formatBytes(result.size)}</span> : null}
                  <span className="block text-[12px] text-[var(--lq-text-dim)]">{result.detail}</span>
                </span>
              </li>
            ))}
            {running ? (
              <li className="flex items-center gap-2 text-[13px] text-[var(--lq-text-dim)]">
                <LoaderCircle className="size-4 flex-none animate-spin" aria-hidden="true" />
                Checking {Math.min(results.length + 1, STEPS)} of {STEPS}…
              </li>
            ) : null}
          </ul>
        ) : null}
        {error ? <p role="alert" className="mt-3 text-[13px] font-medium text-[var(--lq-danger-text)]">{error}</p> : null}
        {finished ? (
          <p role="status" className="mt-3 text-[13.5px] font-semibold">
            {failed === 0 ? 'Everything came back unchanged.' : `${failed} ${failed === 1 ? 'check' : 'checks'} failed. Keep other copies of your photos until this is sorted out.`}
          </p>
        ) : null}
        <DialogActions>
          <DialogDismiss disabled={running}>Close</DialogDismiss>
          <Button variant="accent" disabled={running} onClick={start}>
            {running ? 'Checking…' : finished ? 'Check again' : 'Start check'}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
