import { toWallClock } from '../lib/format';
import type { Engine } from './index';
import { GalleryReadError, RateLimitedError, SessionRevokedError, UserFacingError } from './types';

export { GalleryReadError, type GalleryReadProblem } from './types';

/** How long a new file is left alone, in case whatever made it is still writing. */
const SETTLE_MS = 10_000;
/** A wait longer than this ends the pass, so the phone can sleep until it is over. */
const LONG_WAIT_MS = 2 * 60_000;
/** Only for noticing a request to stop or a lost connection. Finished uploads wake it straight away. */
const POLL_MS = 1000;
/** Tells the app shell this page is still alive, even during one long upload. */
const HEARTBEAT_MS = 30_000;
/** Several failures in a row means Telegram or the network is down, not that these files are bad. */
const MAX_FAILURES_IN_A_ROW = 3;
const OUTAGE_RETRY_MS = 15 * 60_000;
const FIRST_RETRY_MS = 5 * 60_000;
const LONGEST_RETRY_MS = 6 * 60 * 60_000;
/** A file that twice took the page down while being prepared is stored without a thumbnail. */
const CRASHES_BEFORE_SKIPPING_PREVIEWS = 2;
/**
 * One that keeps doing so even then, as a video too large for the phone to read might, is left for
 * a while. Otherwise it would be first in line every time, and nothing after it would get done.
 */
const CRASHES_BEFORE_SETTING_ASIDE = 4;
/** Android sometimes lists a file that is no longer there. It gets another look now and then. */
const MISSING_RETRY_MS = 24 * 60 * 60_000;
const BLOCKED_KEY = 'blockedUntil';
const OWNER_KEY = 'owner';

export interface GalleryItem {
  /** The phone's own id for this file. */
  id: number;
  name: string;
  size: number;
  /** When the file last changed, in seconds, as Android reports it. */
  modified: number;
  /** When it was taken, in milliseconds, if Android knows. */
  taken: number | null;
  /** A video is read from the phone a piece at a time, as it is needed, rather than all at once. */
  kind?: 'photo' | 'video';
}

export type GalleryAccess = 'all' | 'partial' | 'none';
export type NetworkState = 'unmetered' | 'metered' | 'none';

export interface AutoSyncSettings {
  enabled: boolean;
  mobileData: boolean;
}

/** Everything that has to come from the phone. Anything else is ordinary engine work. */
export interface GalleryHost {
  access(): GalleryAccess;
  settings(): AutoSyncSettings;
  network(): NetworkState;
  list(): Promise<GalleryItem[]>;
  /**
   * The file's exact bytes. Throws GalleryReadError rather than ever returning a modified copy. A
   * video's may only be read later, as they are wanted, and its reads throw GalleryReadError too.
   */
  read(item: GalleryItem): Promise<Blob>;
  report(status: AutoSyncStatus): void;
  finished(outcome: PassOutcome): void;
  turnOff(): void;
}

export type AutoSyncPhase =
  /** Turned off. */
  | 'off'
  | 'signed-out'
  /** Needs access to photos and videos, including the part that keeps location in the originals. */
  | 'no-access'
  | 'needs-sign-in'
  | 'checking'
  | 'backing-up'
  | 'waiting-network'
  | 'rate-limited'
  /** Several uploads in a row failed, so it is waiting before trying again. */
  | 'trouble'
  /** Android asked it to stop for now. */
  | 'paused'
  /** Nothing left that can be done right now. */
  | 'idle';

export interface AutoSyncStatus {
  phase: AutoSyncPhase;
  /** Photos and videos seen on the phone at the last check. */
  total: number;
  /** Backed up, or deliberately left alone because the person removed them. */
  done: number;
  /** Files Telegram or the app cannot take, like a file that is not really an image. */
  refused: number;
  /** Waiting to be tried again after a failure. */
  failing: number;
  /** Still to do, not counting those above. */
  remaining: number;
  current: string | null;
  resumeAt: number | null;
  lastDoneAt: number | null;
}

export interface PassOutcome {
  phase: AutoSyncPhase;
  remaining: number;
  resumeAt: number | null;
}

interface LedgerRow {
  id: number;
  modified: number;
  size: number;
  state: 'done' | 'refused' | 'retry' | 'missing';
  sha256: string | null;
  reason: string | null;
  attempts: number;
  nextTry: number;
  /** Times the page went away while this was being prepared. */
  preparing: number;
}

/**
 * What has already been dealt with, kept in its own database so the engine's stays as it is.
 * Without this, every check would have to read and hash every photo on the phone again.
 */
export class GalleryLedger {
  private readonly rows = new Map<number, LedgerRow>();
  private readonly meta = new Map<string, unknown>();

  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = 'tele-photo-gallery'): Promise<GalleryLedger> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('items', { keyPath: 'id' });
        req.result.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const ledger = new GalleryLedger(db);
    await ledger.load();
    return ledger;
  }

  private load(): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['items', 'meta'], 'readonly');
      const items = tx.objectStore('items').getAll() as IDBRequest<LedgerRow[]>;
      items.onsuccess = () => {
        for (const row of items.result) this.rows.set(row.id, row);
      };
      const cursor = tx.objectStore('meta').openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        this.meta.set(String(c.key), c.value);
        c.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  private write(work: (tx: IDBTransaction) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['items', 'meta'], 'readwrite');
      work(tx);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  get(id: number): LedgerRow | undefined {
    return this.rows.get(id);
  }

  put(row: LedgerRow): Promise<void> {
    this.rows.set(row.id, row);
    return this.write((tx) => tx.objectStore('items').put(row));
  }

  /** Forgets files no longer on the phone. Their backups stay in Telegram. */
  async keepOnly(ids: Set<number>): Promise<void> {
    const stale = [...this.rows.keys()].filter((id) => !ids.has(id));
    if (stale.length === 0) return;
    for (const id of stale) this.rows.delete(id);
    await this.write((tx) => {
      for (const id of stale) tx.objectStore('items').delete(id);
    });
  }

  getMeta<T>(key: string): T | undefined {
    return this.meta.get(key) as T | undefined;
  }

  setMeta(key: string, value: unknown): Promise<void> {
    this.meta.set(key, value);
    return this.write((tx) => tx.objectStore('meta').put(value, key));
  }

  async clear(): Promise<void> {
    this.rows.clear();
    this.meta.clear();
    await this.write((tx) => {
      tx.objectStore('items').clear();
      tx.objectStore('meta').clear();
    });
  }

  close(): void {
    this.db.close();
  }
}

type BackupResult = 'done' | 'refused' | 'retry' | 'gone' | 'denied' | 'network' | 'rate-limited' | 'reauth' | 'paused';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const EMPTY_STATUS: AutoSyncStatus = { phase: 'idle', total: 0, done: 0, refused: 0, failing: 0, remaining: 0, current: null, resumeAt: null, lastDoneAt: null };

/**
 * Backs up the phone's gallery, photos and videos, one file at a time, as the original files.
 *
 * A file only counts as done once the engine says Telegram has it, and this is one-way: nothing
 * here ever deletes from the phone or from Telegram. If it is stopped at any point, the next pass
 * carries on from the first photo that is not marked done. Anything already stored is recognised
 * by its hash, so a photo can never be uploaded twice just because a pass was interrupted.
 */
export class AutoSync {
  private state: AutoSyncStatus = { ...EMPTY_STATUS };
  private current: Promise<void> | null = null;
  private rerun = false;
  private retryNow = false;
  private stopRequested = false;
  private lastReport = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly host: GalleryHost,
    private readonly ledger: GalleryLedger,
  ) {}

  status(): AutoSyncStatus {
    return this.state;
  }

  /** Starts a pass, or asks the running one to look again when it finishes. */
  run(options: { retryNow?: boolean } = {}): Promise<void> {
    if (options.retryNow) this.retryNow = true;
    this.stopRequested = false;
    if (this.current) {
      this.rerun = true;
      return this.current;
    }
    this.current = this.loop().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  /** Stops soon, leaving everything so the next pass can carry on. */
  pause(): void {
    this.stopRequested = true;
    this.rerun = false;
  }

  /** Waits for the pass to end. For sign-out and tests. */
  settled(): Promise<void> {
    return this.current ?? Promise.resolve();
  }

  async signOut(): Promise<void> {
    this.pause();
    await this.settled();
    this.host.turnOff();
    await this.ledger.clear();
    this.state = { ...EMPTY_STATUS, phase: 'signed-out' };
  }

  private set(change: Partial<AutoSyncStatus>, force = false): void {
    this.state = { ...this.state, ...change };
    const now = Date.now();
    if (force || now - this.lastReport >= 500) {
      this.lastReport = now;
      this.host.report(this.state);
    }
  }

  private async loop(): Promise<void> {
    this.heartbeat = setInterval(() => this.set({}, true), HEARTBEAT_MS);
    let outcome: PassOutcome;
    try {
      do {
        this.rerun = false;
        outcome = await this.pass();
      } while (this.rerun && !this.stopRequested);
    } catch (err) {
      console.error('Auto backup stopped', err);
      outcome = this.end('trouble', Date.now() + OUTAGE_RETRY_MS);
    } finally {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    // Albums and camera details go up now, as the page may be closed as soon as this returns.
    await this.engine.sync.flush().catch(() => false);
    this.host.finished(outcome);
  }

  private end(phase: AutoSyncPhase, resumeAt: number | null = null): PassOutcome {
    this.set({ phase, resumeAt, current: null }, true);
    return { phase, remaining: this.state.remaining, resumeAt };
  }

  private allowed(): 'yes' | 'no' {
    const network = this.host.network();
    if (network === 'unmetered') return 'yes';
    return network === 'metered' && this.host.settings().mobileData ? 'yes' : 'no';
  }

  private async pass(): Promise<PassOutcome> {
    const { engine, host, ledger } = this;
    if (!host.settings().enabled) return this.end('off');
    if (!engine.store.account?.session && !engine.store.account?.needs_reauth) return this.end('signed-out');
    if (engine.store.account.needs_reauth) return this.end('needs-sign-in');
    if (host.access() === 'none') return this.end('no-access');

    const owner = engine.store.account.tg_user_id;
    if (ledger.getMeta<string>(OWNER_KEY) !== owner) {
      await ledger.clear();
      await ledger.setMeta(OWNER_KEY, owner);
    }
    const blockedUntil = ledger.getMeta<number>(BLOCKED_KEY) ?? 0;
    if (blockedUntil > Date.now()) return this.end('rate-limited', blockedUntil);

    this.set({ phase: 'checking', current: null, resumeAt: null }, true);
    const interrupted = await this.catchUp();
    if (interrupted) return interrupted;
    const account = engine.store.account;
    if (!account?.session || account.needs_reauth) return this.end(account?.needs_reauth ? 'needs-sign-in' : 'signed-out');

    let failuresInARow = 0;
    for (;;) {
      const items = await host.list();
      await ledger.keepOnly(new Set(items.map((i) => i.id)));
      const plan = this.plan(items);
      this.retryNow = false;
      this.set({ total: items.length - plan.missing, done: plan.done, refused: plan.refused, failing: plan.failing, remaining: plan.todo.length }, true);

      for (const item of plan.todo) {
        if (this.stopRequested) return this.end('paused');
        if (this.allowed() === 'no') return this.end('waiting-network');
        this.set({ phase: 'backing-up', current: item.name });

        const result = await this.backUp(item);
        const counts = { remaining: Math.max(0, this.state.remaining - 1) };
        switch (result) {
          case 'done':
            failuresInARow = 0;
            this.set({ ...counts, done: this.state.done + 1, lastDoneAt: Date.now() }, true);
            break;
          case 'refused':
            this.set({ ...counts, refused: this.state.refused + 1 }, true);
            break;
          case 'gone':
            this.set({ ...counts, total: Math.max(0, this.state.total - 1) }, true);
            break;
          case 'retry':
            this.set({ ...counts, failing: this.state.failing + 1 }, true);
            if (++failuresInARow >= MAX_FAILURES_IN_A_ROW) return this.end('trouble', Date.now() + OUTAGE_RETRY_MS);
            break;
          case 'denied':
            return this.end('no-access');
          case 'network':
            return this.end('waiting-network');
          case 'reauth':
            return this.end('needs-sign-in');
          case 'paused':
            return this.end('paused');
          case 'rate-limited': {
            const until = ledger.getMeta<number>(BLOCKED_KEY) ?? Date.now() + LONG_WAIT_MS;
            return this.end('rate-limited', until);
          }
        }
      }

      if (this.stopRequested) return this.end('paused');
      // Looks again after doing anything, as photos may have been taken while this was busy.
      if (plan.todo.length > 0) continue;
      if (plan.settling > 0) {
        await sleep(SETTLE_MS);
        continue;
      }
      return this.end('idle', this.earliestRetry(items));
    }
  }

  /**
   * Waits for the engine to learn what Telegram holds, which takes a while on a large library.
   * Returns how the pass ends if it cannot carry on. Nothing goes up after a failure, because a
   * photo it had not got to yet would look new and be sent a second time.
   */
  private async catchUp(): Promise<PassOutcome | null> {
    const finished = this.engine.whenCaughtUp().then(
      () => ({ failed: false as const }),
      (failure: unknown) => ({ failed: true as const, failure }),
    );
    for (;;) {
      const result = await Promise.race([finished, sleep(POLL_MS)]);
      if (result) return result.failed ? this.afterFailedCatchUp(result.failure) : null;
      if (this.stopRequested) return this.end('paused');
    }
  }

  private async afterFailedCatchUp(failure: unknown): Promise<PassOutcome> {
    if (failure instanceof SessionRevokedError || this.engine.store.account?.needs_reauth) return this.end('needs-sign-in');
    if (failure instanceof RateLimitedError) {
      const until = Date.now() + (failure.seconds + 1) * 1000;
      await this.ledger.setMeta(BLOCKED_KEY, until);
      return this.end('rate-limited', until);
    }
    // The time only asks Android to look again, which it does once there is a connection to use.
    if (this.allowed() === 'no') return this.end('waiting-network', Date.now());
    return this.end('trouble', Date.now() + OUTAGE_RETRY_MS);
  }

  private earliestRetry(items: GalleryItem[]): number | null {
    let earliest: number | null = null;
    for (const item of items) {
      const row = this.ledger.get(item.id);
      if (row?.state === 'retry' && row.nextTry > 0 && (earliest === null || row.nextTry < earliest)) earliest = row.nextTry;
    }
    return earliest;
  }

  private plan(items: GalleryItem[]) {
    const now = Date.now();
    const plan = { todo: [] as GalleryItem[], done: 0, refused: 0, failing: 0, settling: 0, missing: 0 };
    for (const item of items) {
      const row = this.ledger.get(item.id);
      const unchanged = row !== undefined && row.modified === item.modified && row.size === item.size;
      if (unchanged && row.state === 'done') {
        plan.done++;
      } else if (unchanged && row.state === 'refused') {
        plan.refused++;
      } else if (unchanged && row.state === 'missing' && row.nextTry > now) {
        plan.missing++;
      } else if (item.modified * 1000 > now - SETTLE_MS && item.modified * 1000 <= now) {
        plan.settling++;
      } else if (unchanged && row.state === 'retry' && row.nextTry > now && !this.retryNow) {
        plan.failing++;
      } else {
        plan.todo.push(item);
      }
    }
    // The newest first, as those are the ones with no other copy yet and the ones people look for.
    plan.todo.sort((a, b) => b.id - a.id);
    return plan;
  }

  private async backUp(item: GalleryItem): Promise<BackupResult> {
    const { engine, host, ledger } = this;
    const previous = ledger.get(item.id);
    const unchanged = previous !== undefined && previous.modified === item.modified && previous.size === item.size;
    const attempts = unchanged ? previous.attempts : 0;
    const preparing = unchanged ? previous.preparing : 0;
    const row = (change: Partial<LedgerRow> = {}): LedgerRow => ({
      id: item.id, modified: item.modified, size: item.size, state: 'retry', sha256: null, reason: null, attempts, nextTry: 0, preparing: 0, ...change,
    });
    const retryLater = async (reason: string): Promise<BackupResult> => {
      const delay = Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** attempts);
      await ledger.put(row({ reason, attempts: attempts + 1, nextTry: Date.now() + delay }));
      return 'retry';
    };

    if (preparing >= CRASHES_BEFORE_SETTING_ASIDE) return retryLater('This file stopped the app every time it was opened.');

    // Saved first, so a crash while reading or decoding it is remembered, and cannot repeat for ever.
    // A video can be gigabytes, so even reading it is something that might not survive.
    await ledger.put(row({ preparing: preparing + 1 }));
    /** A changed file is tried again, as the next look at the gallery sees it as a new version. */
    const unreadable = async (err: unknown): Promise<BackupResult> => {
      const problem = err instanceof GalleryReadError ? err.problem : 'failed';
      if (problem === 'gone') {
        await ledger.put(row({ state: 'missing', nextTry: Date.now() + MISSING_RETRY_MS }));
        return 'gone';
      }
      if (problem === 'denied') return 'denied';
      return retryLater(err instanceof Error ? err.message : 'This file could not be read.');
    };

    let file: Blob;
    try {
      file = await host.read(item);
    } catch (err) {
      return unreadable(err);
    }

    let result;
    try {
      const when = toWallClock(item.taken ?? item.modified * 1000);
      result = await engine.ingest(file, item.name, when, undefined, { autoSync: true, skipPreviews: preparing >= CRASHES_BEFORE_SKIPPING_PREVIEWS });
    } catch (err) {
      // A video is read as it is hashed, so the phone can still refuse it, or it can change, by now.
      if (err instanceof GalleryReadError) return unreadable(err);
      if (err instanceof UserFacingError) {
        if (err.status === 401) return 'reauth';
        // Could be a file something is still writing, so this one is worth another look.
        if (err.code === 'EMPTY_FILE') return retryLater(err.message);
        if (err.status >= 400 && err.status < 500) {
          await ledger.put(row({ state: 'refused', reason: err.message }));
          return 'refused';
        }
      }
      return retryLater(err instanceof Error ? err.message : 'This file could not be prepared.');
    }
    await ledger.put(row());

    if (result.skipped) {
      await ledger.put(row({ state: 'done', reason: result.skipped }));
      return 'done';
    }

    const outcome = await this.waitForTelegram(result.id);
    switch (outcome) {
      case 'stored':
        await ledger.put(row({ state: 'done', sha256: engine.store.getPhoto(result.id)?.sha256 ?? null, attempts: 0 }));
        return 'done';
      case 'failed': {
        const message = engine.store.getPhoto(result.id)?.last_error ?? 'Could not save to Telegram.';
        // Let go of the file. The next pass reads it again, and the failed row is picked back up by its hash.
        engine.queue.detach(result.id);
        return retryLater(message);
      }
      case 'removed':
        // The person cancelled or deleted it while it was going up.
        await ledger.put(row({ state: 'done', reason: 'removed' }));
        return 'done';
      default:
        return outcome;
    }
  }

  private async waitForTelegram(id: number): Promise<'stored' | 'failed' | 'removed' | 'network' | 'rate-limited' | 'reauth' | 'paused'> {
    const { engine, ledger } = this;
    for (;;) {
      const photo = engine.store.getPhoto(id);
      if (!photo) return 'removed';
      if (photo.status === 'stored') return 'stored';
      if (photo.status === 'failed') return 'failed';
      if (engine.store.account?.needs_reauth || !engine.store.account?.session) return 'reauth';
      if (this.stopRequested) return 'paused';
      if (this.allowed() === 'no') return 'network';
      if (photo.status === 'queued' && photo.next_attempt_at - Date.now() > LONG_WAIT_MS) {
        // A wait with no error is Telegram's own request, and it applies to the whole account.
        if (photo.last_error === null) {
          await ledger.setMeta(BLOCKED_KEY, photo.next_attempt_at);
          return 'rate-limited';
        }
      }
      engine.queue.notify();
      await Promise.race([sleep(POLL_MS), engine.queue.whenChanged()]);
    }
  }
}
