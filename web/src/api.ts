import { androidBridge, androidGallery, androidSettings, onNativeEvent } from '@/engine/android';
import { AutoSync, type AutoSyncStatus, GalleryLedger } from '@/engine/autosync';
import { downloadOriginals } from '@/engine/download';
import { FakeStorage } from '@/engine/fake';
import { Engine, UserFacingError } from '@/engine/index';
import { type VerifyResult, verifyStorage } from '@/engine/verify';

export type {
  Account, Album, LibraryStats, PhotoDetail, PhotoItem, PhotoQuery, QueueItem, ScanState, Session, UploadStatus,
} from '@/engine/index';
export type { VerifyResult };
/** Failures come from the engine in this browser now, with the same shape the screens already handled. */
export { UserFacingError as ApiError };

const apiId = Number.parseInt(import.meta.env.VITE_TELEGRAM_API_ID ?? '', 10);
const apiHash = (import.meta.env.VITE_TELEGRAM_API_HASH ?? '').trim();
const isFake = import.meta.env.VITE_STORAGE === 'fake';
const hasKeys = Number.isFinite(apiId) && apiId > 0 && apiHash !== '';
const retention = Number.parseInt(import.meta.env.VITE_TRASH_RETENTION_DAYS ?? '', 10);
/** Lets demo mode try splitting without gigabytes of video. Real Telegram always uses its real limits. */
const fakePieceBytes = isFake ? Number.parseInt(import.meta.env.VITE_FAKE_PIECE_BYTES ?? '', 10) : Number.NaN;

let starting: Promise<Engine> | null = null;
let autoSync: AutoSync | null = null;

/** Only inside the Android app. It keeps going for as long as this page does. */
async function startAutoSync(engine: Engine): Promise<void> {
  const bridge = androidBridge();
  if (!bridge) return;
  const sync = new AutoSync(engine, androidGallery(bridge), await GalleryLedger.open());
  autoSync = sync;
  onNativeEvent('run', () => void sync.run());
  onNativeEvent('access-changed', () => void sync.run());
  onNativeEvent('pause', () => sync.pause());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void sync.run();
  });
  bridge.ready();
  void sync.run();
}

async function boot(): Promise<Engine> {
  // GramJS is most of the app's code, and is only needed once this tab is really going to use it.
  const storage = isFake ? new FakeStorage() : new (await import('@/engine/telegram')).TelegramStorage(apiId || 0, apiHash);
  const engine = await Engine.open({
    storage,
    configured: isFake || hasKeys,
    trashRetentionDays: Number.isFinite(retention) && retention > 0 ? retention : undefined,
    split: fakePieceBytes > 0 ? { maxSingleBytes: fakePieceBytes, pieceBytes: fakePieceBytes } : undefined,
  });
  await startAutoSync(engine);
  return engine;
}

/** One engine for the whole tab, started the first time anything needs it. */
export function getEngine(): Promise<Engine> {
  starting ??= boot().catch((err) => {
    starting = null;
    throw err;
  });
  return starting;
}

/** Stops this tab's engine, for when another tab takes over the library. */
export async function stopEngine(): Promise<void> {
  const running = starting;
  starting = null;
  await running?.then((engine) => engine.close()).catch(() => undefined);
}

const withEngine = <T>(work: (engine: Engine) => T | Promise<T>) => getEngine().then(work);

export const api = {
  session: () => withEngine((e) => e.session()),
  sendCode: (phone: string) => withEngine((e) => e.sendCode(phone)),
  submitCode: (loginId: string, code: string) => withEngine((e) => e.submitCode(loginId, code)),
  submitPassword: (loginId: string, password: string) => withEngine((e) => e.submitPassword(loginId, password)),
  signOut: () =>
    withEngine(async (e) => {
      await autoSync?.signOut();
      await e.signOut();
    }),

  photos: (query: Parameters<Engine['photos']>[0]) => withEngine((e) => e.photos(query)),
  photo: (id: number) => withEngine((e) => e.photo(id)),
  setFavorite: (ids: number[], favorite: boolean) => withEngine((e) => e.setFavorite(ids, favorite)),
  setTrashed: (ids: number[], trashed: boolean) => withEngine((e) => e.setTrashed(ids, trashed)),
  deleteForever: (ids: number[]) => withEngine((e) => e.deleteForever(ids)),
  emptyTrash: () => withEngine((e) => e.emptyTrash()),

  albums: () => withEngine((e) => e.albums()),
  album: (id: number) => withEngine((e) => e.album(id)),
  createAlbum: (title: string, photoIds: number[] = []) => withEngine((e) => e.createAlbum(title, photoIds)),
  updateAlbum: (id: number, body: { title?: string; coverPhotoId?: number | null }) => withEngine((e) => e.updateAlbum(id, body)),
  deleteAlbum: (id: number) => withEngine((e) => e.deleteAlbum(id)),
  addToAlbum: (id: number, ids: number[]) => withEngine((e) => e.addToAlbum(id, ids)),
  removeFromAlbum: (id: number, ids: number[]) => withEngine((e) => e.removeFromAlbum(id, ids)),

  uploadStatus: () => withEngine((e) => e.uploadStatus()),
  retryUploads: (ids?: number[]) => withEngine((e) => e.retryUploads(ids)),
  cancelUpload: (id: number) => withEngine((e) => e.cancelUpload(id)),
  rescan: () => withEngine((e) => e.rescan()),
  library: () => withEngine((e) => e.libraryInfo()),

  /** Sends generated files through real Telegram and back, then compares them. */
  verifyStorage: (onResult: (result: VerifyResult) => void) =>
    withEngine((e) => {
      const account = e.store.account;
      if (!account?.session || !account.channel_id || !account.channel_access_hash) throw new UserFacingError('NOT_SIGNED_IN', 'Please sign in.', 401);
      const context = { session: account.session, library: { channelId: account.channel_id, accessHash: account.channel_access_hash } };
      return verifyStorage(e, context, onResult);
    }),
};

/** Has to be called from the click itself, so that a browser allows the save dialog for a large download. */
export const downloadPhotos = (ids: number[]) => withEngine((e) => downloadOriginals(e, ids));

export interface AutoBackupState extends AutoSyncStatus {
  enabled: boolean;
  mobileData: boolean;
  batteryExempt: boolean;
  access: 'all' | 'partial' | 'none';
  network: 'unmetered' | 'metered' | 'none';
}

/** Automatic backup of the phone's gallery. Only the Android app has one to back up. */
export const autoBackup = {
  available: androidBridge() !== null,

  state: () =>
    withEngine((): AutoBackupState | null => {
      const bridge = androidBridge();
      if (!bridge || !autoSync) return null;
      return { ...autoSync.status(), ...androidSettings(bridge), access: bridge.access(), network: bridge.network() };
    }),

  /** Asks Android for whatever is still needed. The app starts by itself once it has it. */
  turnOn: () =>
    withEngine(() => {
      const bridge = androidBridge();
      if (!bridge) return;
      bridge.setEnabled(true);
      if (bridge.access() === 'all') void autoSync?.run();
      else bridge.requestAccess();
    }),

  turnOff: () =>
    withEngine(() => {
      androidBridge()?.setEnabled(false);
      autoSync?.pause();
      return autoSync?.settled().then(() => autoSync?.run());
    }),

  setMobileData: (allowed: boolean) =>
    withEngine(() => {
      androidBridge()?.setMobileData(allowed);
      void autoSync?.run();
    }),

  run: () =>
    withEngine(() => {
      void autoSync?.run();
    }),

  retryNow: () =>
    withEngine(() => {
      void autoSync?.run({ retryNow: true });
    }),

  /** Whether a failed upload can be left to automatic backup, rather than asking for the file. */
  handlesRetries: (): boolean => {
    const bridge = androidBridge();
    return bridge !== null && androidSettings(bridge).enabled;
  },

  requestAccess: () => androidBridge()?.requestAccess(),
  requestBatteryExemption: () => androidBridge()?.requestBatteryExemption(),
  openAppSettings: () => androidBridge()?.openAppSettings(),
};
