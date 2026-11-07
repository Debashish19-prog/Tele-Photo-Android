import { useQueryClient } from '@tanstack/react-query';
import { BatteryCharging, Check, CloudUpload, Image, TriangleAlert, Wifi } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { type AutoBackupState, autoBackup } from '@/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions, DialogContent, DialogDismiss, DialogTitle } from '@/components/ui/dialog';
import { Progress, ProgressTrack } from '@/components/ui/progress';
import { Toggle } from '@/components/ui/toggle';
import { useAutoBackup } from '@/hooks/useAutoBackup';
import { formatCount } from '@/lib/format';

const DISMISSED_KEY = 'tele-photo-auto-backup-dismissed';

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function minutesUntil(at: number | null): string {
  if (at === null) return 'a while';
  const minutes = Math.max(1, Math.ceil((at - Date.now()) / 60_000));
  return minutes >= 90 ? `about ${Math.round(minutes / 60)} hours` : `about ${minutes} min`;
}

/** One sentence saying where things stand, which the banner and the dialog both show. */
export function describe(state: AutoBackupState): string {
  const left = formatCount(state.remaining + state.failing, 'photo');
  // It may have stopped before counting anything, and "0 photos left" would read as finished.
  const stillLeft = state.remaining + state.failing > 0 ? ` ${left} left.` : '';
  switch (state.phase) {
    case 'off':
      return 'Auto backup is off.';
    case 'signed-out':
      return 'Sign in to back up this phone.';
    case 'no-access':
      return 'Auto backup needs access to your photos.';
    case 'needs-sign-in':
      return 'Telegram ended this session. Sign in again to continue.';
    case 'checking':
      return 'Looking for new photos…';
    case 'backing-up':
      return `Backing up. ${state.done.toLocaleString()} of ${state.total.toLocaleString()} done.`;
    case 'waiting-network':
      return state.network === 'none'
        ? `Waiting for a connection.${stillLeft}`
        : `Waiting for Wi-Fi.${stillLeft}`;
    case 'rate-limited':
      return `Telegram asked us to wait ${minutesUntil(state.resumeAt)}.${stillLeft}`;
    case 'trouble':
      return `Could not reach Telegram. Trying again in ${minutesUntil(state.resumeAt)}.`;
    case 'paused':
      return `Android paused the backup for now.${stillLeft}`;
    case 'idle':
      return state.failing > 0 ? `${left} could not be saved, and will be tried again.` : 'Every photo on this phone is backed up.';
  }
}

function fraction(state: AutoBackupState): number {
  const counted = state.done + state.remaining + state.failing;
  return counted === 0 ? 0 : state.done / counted;
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ['auto-backup'] });
}

function Strip({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div role="status" className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl bg-[var(--lq-highlight)] px-4 py-3 text-[13.5px]">
      <span className="flex-none text-[var(--lq-accent)]">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

/** Only appears when there is something to see or to do. A finished backup needs no announcement. */
export function AutoBackupBanner({ needsSignIn }: { needsSignIn: boolean }) {
  const { data: state } = useAutoBackup();
  const refresh = useRefresh();
  const [dismissed, setDismissed] = useState(wasDismissed);

  // Signing in again does not reload the page, so this is what picks the backup back up.
  useEffect(() => {
    if (autoBackup.available && !needsSignIn) void autoBackup.run();
  }, [needsSignIn]);

  if (!autoBackup.available || !state) return null;

  if (!state.enabled) {
    if (dismissed) return null;
    return (
      <Strip icon={<CloudUpload className="size-5" aria-hidden="true" />}
        action={
          <div className="flex gap-2">
            <Button size="sm" variant="glass" onClick={() => {
              try {
                localStorage.setItem(DISMISSED_KEY, '1');
              } catch {
                // Then this just asks again next time.
              }
              setDismissed(true);
            }}>Not now</Button>
            <Button size="sm" variant="accent" onClick={() => void autoBackup.turnOn().then(refresh)}>Turn on</Button>
          </div>
        }
      >
        <p className="font-semibold">Back up this phone automatically</p>
        <p className="text-[12.5px] text-[var(--lq-text-dim)]">Every photo in your gallery goes to your Telegram as the original file.</p>
      </Strip>
    );
  }

  if (state.access === 'none') {
    return (
      <Strip icon={<Image className="size-5" aria-hidden="true" />} action={<Button size="sm" variant="accent" onClick={() => autoBackup.requestAccess()}>Allow</Button>}>
        <p className="font-semibold">Auto backup needs access to your photos</p>
        <p className="text-[12.5px] text-[var(--lq-text-dim)]">Choose "Allow all". If Android no longer asks, turn on Photos in the app's settings.</p>
      </Strip>
    );
  }

  const partial = state.access === 'partial' ? (
    <Strip icon={<Image className="size-5" aria-hidden="true" />} action={<Button size="sm" variant="accent" onClick={() => autoBackup.requestAccess()}>Allow all</Button>}>
      <p className="font-semibold">Only the photos you selected are being backed up</p>
      <p className="text-[12.5px] text-[var(--lq-text-dim)]">Allow all photos to back up the whole gallery.</p>
    </Strip>
  ) : null;

  const quiet = state.phase === 'idle' || state.phase === 'off' || state.phase === 'signed-out' || state.phase === 'needs-sign-in' || (state.phase === 'checking' && state.total === 0);
  if (quiet) return partial;

  return (
    <>
      {partial}
      <Strip icon={state.phase === 'waiting-network' ? <Wifi className="size-5" aria-hidden="true" /> : state.phase === 'trouble' ? <TriangleAlert className="size-5" aria-hidden="true" /> : <CloudUpload className="size-5" aria-hidden="true" />}>
        <p className="font-medium" data-auto-backup={state.phase}>{describe(state)}</p>
        {state.phase === 'backing-up' ? (
          <Progress value={Math.round(fraction(state) * 100)} aria-label="Backup progress" className="mt-1.5">
            <ProgressTrack className="h-1.5" glass={{ material: 'clear' }} />
          </Progress>
        ) : null}
      </Strip>
    </>
  );
}

function Row({ icon, title, detail, control }: { icon: ReactNode; title: string; detail: string; control: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <span className="flex-none text-[var(--lq-text-dim)]">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-semibold">{title}</p>
        <p className="text-[12px] text-[var(--lq-text-dim)]">{detail}</p>
      </div>
      <div className="flex-none">{control}</div>
    </div>
  );
}

export function AutoBackupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: state } = useAutoBackup();
  const refresh = useRefresh();
  if (!autoBackup.available) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="lq-solid" glass={{ frost: 1, blur: 6 }}>
        <DialogTitle>Auto backup</DialogTitle>
        {state ? (
          <>
            <p role="status" className="mt-1 text-[13.5px] text-[var(--lq-text-dim)]" data-auto-backup-detail={state.phase}>{state.enabled ? describe(state) : 'Auto backup is off.'}</p>
            <div className="mt-2 divide-y divide-[var(--app-line)]">
              <Row
                icon={<CloudUpload className="size-5" aria-hidden="true" />}
                title="Back up this phone"
                detail="New photos go to Telegram by themselves"
                control={
                  <Toggle aria-label="Back up this phone" pressed={state.enabled} onPressedChange={(on) => void (on ? autoBackup.turnOn() : autoBackup.turnOff()).then(refresh)}>
                    {state.enabled ? 'On' : 'Off'}
                  </Toggle>
                }
              />
              <Row
                icon={<Wifi className="size-5" aria-hidden="true" />}
                title="Use mobile data"
                detail="Originals are large, so this is off unless you turn it on"
                control={
                  <Toggle aria-label="Use mobile data" pressed={state.mobileData} onPressedChange={(on) => void autoBackup.setMobileData(on).then(refresh)}>
                    {state.mobileData ? 'On' : 'Off'}
                  </Toggle>
                }
              />
              {state.enabled ? (
                <Row
                  icon={<BatteryCharging className="size-5" aria-hidden="true" />}
                  title="Run in the background"
                  detail={state.batteryExempt ? 'Android lets the backup keep going when the app is closed' : 'Without this, Android may stop the backup after a few minutes'}
                  control={state.batteryExempt ? <Check className="size-5 text-emerald-500" aria-label="Allowed" /> : <Button size="sm" variant="accent" onClick={() => autoBackup.requestBatteryExemption()}>Allow</Button>}
                />
              ) : null}
              {state.enabled && state.access !== 'all' ? (
                <Row
                  icon={<Image className="size-5" aria-hidden="true" />}
                  title={state.access === 'partial' ? 'Only selected photos' : 'No access to photos'}
                  detail='Choose "Allow all" so that the whole gallery is backed up'
                  control={<Button size="sm" variant="accent" onClick={() => autoBackup.openAppSettings()}>Settings</Button>}
                />
              ) : null}
            </div>
            {state.enabled ? (
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
                <dt className="text-[var(--lq-text-dim)]">On this phone</dt>
                <dd className="text-right font-medium" data-backup-total>{state.total.toLocaleString()}</dd>
                <dt className="text-[var(--lq-text-dim)]">Backed up</dt>
                <dd className="text-right font-medium" data-backup-done>{state.done.toLocaleString()}</dd>
                <dt className="text-[var(--lq-text-dim)]">Still to go</dt>
                <dd className="text-right font-medium">{(state.remaining + state.failing).toLocaleString()}</dd>
                {state.refused > 0 ? (
                  <>
                    <dt className="text-[var(--lq-text-dim)]">Could not be stored</dt>
                    <dd className="text-right font-medium">{state.refused.toLocaleString()}</dd>
                  </>
                ) : null}
              </dl>
            ) : null}
            {state.failing > 0 ? <Button className="mt-3" size="sm" variant="glass" onClick={() => void autoBackup.retryNow().then(refresh)}>Try again now</Button> : null}
            <p className="mt-3 text-[12px] text-[var(--lq-text-dim)]">
              Photos are sent as the original files, byte for byte, including their location. Removing a photo from this phone does not remove its backup, and a photo you delete in this app stays deleted. Videos are not backed up yet.
            </p>
          </>
        ) : null}
        <DialogActions>
          <DialogDismiss>Close</DialogDismiss>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
