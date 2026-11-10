import { LiquiGlass } from '@liqui-design/glass';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudUpload, LogOut, Moon, RefreshCw, Search, ShieldCheck, Sun, SunMoon, Upload, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Link, Route, Switch, useLocation, useSearch } from 'wouter';
import { type Account, api, autoBackup } from '@/api';
import { AutoBackupBanner, AutoBackupDialog } from '@/components/AutoBackup';
import { ConfirmDialog, type ConfirmRequest } from '@/components/ConfirmDialog';
import { CrystalButton, CrystalLink } from '@/components/CrystalButton';
import { DemoBadge } from '@/components/DemoBadge';
import { LogoMark } from '@/components/Logo';
import { StorageCheckDialog } from '@/components/StorageCheckDialog';
import { UploadPanel } from '@/components/UploadPanel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Menu, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { TabBar, TabBarItem } from '@/components/ui/tab-bar';
import { Toaster, useToast } from '@/components/ui/toast';
import { setTheme, type ThemeChoice, useTheme } from '@/hooks/useTheme';
import { useUploadStatus } from '@/hooks/useUploadStatus';
import { formatCount } from '@/lib/format';
import { QUICK } from '@/lib/motion';
import { ACCEPTED_FILES, filesFromDrop, uploader } from '@/lib/uploads';
import { AlbumPage, AlbumsPage, FavoritesPage, PhotosPage, SearchPage, TrashPage } from '@/pages/Pages';

const NAV = [
  { href: '/', label: 'Photos' },
  { href: '/favorites', label: 'Favorites' },
  { href: '/albums', label: 'Albums' },
  { href: '/trash', label: 'Trash' },
] as const;

function activeSection(path: string): string {
  if (path.startsWith('/albums')) return '/albums';
  return NAV.find((item) => item.href === path)?.href ?? '';
}

/** A menu often opens over a dark photo, and it has to stay readable there. */
const MENU_GLASS = { frost: 1, blur: 6 } as const;

const FILE_INPUT_ID = 'tp-file-input';
export const openFilePicker = () => document.getElementById(FILE_INPUT_ID)?.click();

/** The wrapper holds the breakpoint, because a crystal sets its own display. */
function Brand() {
  return (
    <div className="hidden flex-none min-[720px]:flex">
      <Link href="/" asChild>
        <CrystalLink aria-label="Tele-Photo home" className="h-12 pr-5 pl-3">
          <LogoMark size={24} />
          <span className="text-[15px] font-bold tracking-tight">Tele-Photo</span>
        </CrystalLink>
      </Link>
    </div>
  );
}

function SearchBox() {
  const [path, navigate] = useLocation();
  const search = useSearch();
  const urlValue = path === '/search' ? new URLSearchParams(search).get('q') ?? '' : '';
  const [value, setValue] = useState(urlValue);
  const lastSent = useRef(urlValue);

  useEffect(() => {
    if (urlValue !== lastSent.current) {
      lastSent.current = urlValue;
      setValue(urlValue);
    }
  }, [urlValue]);

  useEffect(() => {
    const term = value.trim();
    if (term === lastSent.current.trim()) return;
    const timer = setTimeout(() => {
      lastSent.current = term;
      if (term) navigate(`/search?q=${encodeURIComponent(term)}`, { replace: path === '/search' });
      else if (path === '/search') navigate('/', { replace: true });
    }, 260);
    return () => clearTimeout(timer);
  }, [value, navigate, path]);

  return (
    <div role="search" className="min-w-0 flex-1">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search your photos"
        className="lq-round"
        aria-label="Search your photos"
        glass={{ radius: 24, frost: 0.72, blur: 1, refraction: 60, bezel: 16, elevated: true }}
        inputClassName="py-[13px] text-[14.5px]"
        start={<Search className="ml-1 size-[18px] text-[var(--lq-text-dim)]" aria-hidden="true" />}
        end={
          value ? (
            <button type="button" aria-label="Clear search" className="grid size-7 cursor-pointer place-items-center rounded-full hover:bg-[var(--lq-highlight)]" onClick={() => setValue('')}>
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : null
        }
      />
    </div>
  );
}

function UserMenu({ account, onSignedOut }: { account: Account; onSignedOut: () => void }) {
  const theme = useTheme();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [checking, setChecking] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const name = [account.firstName, account.lastName].filter(Boolean).join(' ') || account.username || account.phone;
  const initial = (name.trim()[0] ?? '?').toUpperCase();

  return (
    <>
      <Menu>
        <MenuTrigger
          aria-label={`Account: ${name}`}
          render={
            <CrystalButton className="size-12 flex-none">
              <span className="text-[15px]">{initial}</span>
            </CrystalButton>
          }
        />
        <MenuContent align="end" className="lq-solid w-64" glass={MENU_GLASS}>
          <div className="px-2.5 pt-1.5 pb-2">
            <p className="truncate text-[13.5px] font-semibold">{name}</p>
            <p className="truncate text-[12px] text-[var(--lq-text-dim)]">{account.phone}</p>
          </div>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Appearance</MenuGroupLabel>
            <MenuRadioGroup value={theme} onValueChange={(value: ThemeChoice) => setTheme(value)}>
              <MenuRadioItem value="system">
                <SunMoon className="size-4" aria-hidden="true" /> Match this device
              </MenuRadioItem>
              <MenuRadioItem value="light">
                <Sun className="size-4" aria-hidden="true" /> Light
              </MenuRadioItem>
              <MenuRadioItem value="dark">
                <Moon className="size-4" aria-hidden="true" /> Dark
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
          <MenuSeparator />
          {autoBackup.available ? (
            <MenuItem onClick={() => setBackupOpen(true)}>
              <CloudUpload className="size-4" aria-hidden="true" /> Auto backup
            </MenuItem>
          ) : null}
          <MenuItem
            onClick={() =>
              void api.rescan().then(
                () => {
                  toast.add({ title: 'Checking your Telegram library', description: 'Anything missing from this device will be restored.' });
                  void queryClient.invalidateQueries({ queryKey: ['upload-status'] });
                },
                (err: Error) => toast.add({ title: 'That did not work', description: err.message, type: 'error' }),
              )
            }
          >
            <RefreshCw className="size-4" aria-hidden="true" /> Restore from Telegram
          </MenuItem>
          <MenuItem onClick={() => setChecking(true)}>
            <ShieldCheck className="size-4" aria-hidden="true" /> Check Telegram storage
          </MenuItem>
          <MenuItem
            variant="danger"
            onClick={() =>
              setConfirm({
                title: autoBackup.available ? 'Sign out of this phone?' : 'Sign out of this browser?',
                description: autoBackup.available
                  ? 'This ends its Telegram session, turns off auto backup and clears its thumbnails and index. Your photos, albums and favorites stay in your Telegram, and come back when you sign in again. Anything still uploading will stop.'
                  : 'This ends its Telegram session and clears its thumbnails and index. Your photos, albums and favorites stay in your Telegram, and come back when you sign in again. Anything still uploading will stop.',
                confirm: 'Sign out',
                onConfirm: () => api.signOut().then(onSignedOut),
              })
            }
          >
            <LogOut className="size-4" aria-hidden="true" /> Sign out
          </MenuItem>
        </MenuContent>
      </Menu>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <StorageCheckDialog open={checking} onClose={() => setChecking(false)} />
      <AutoBackupDialog open={backupOpen} onClose={() => setBackupOpen(false)} />
    </>
  );
}

function DropOverlay({ onFiles, albumTitle }: { onFiles: (files: File[]) => void; albumTitle: string | null }) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth.current++;
      setDragging(true);
    };
    const onOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onLeave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (event.dataTransfer) void filesFromDrop(event.dataTransfer).then(onFiles);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onFiles]);

  return (
    <AnimatePresence>
      {dragging ? (
        <motion.div
          key="drop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={QUICK}
          className="pointer-events-none fixed inset-0 z-[60] grid place-items-center bg-[var(--lq-scrim)] p-6"
        >
          <motion.div initial={{ scale: 0.94 }} animate={{ scale: 1 }}>
            <LiquiGlass radius={32} elevated frost={0.7} blur={2} refraction={110} bezel={30} contentClassName="flex flex-col items-center gap-3 px-14 py-11 text-center">
              <Upload className="size-10 text-[var(--lq-accent)]" aria-hidden="true" />
              <p className="max-w-[60vw] truncate text-lg font-semibold">{albumTitle ? `Drop to add to ${albumTitle}` : 'Drop to upload'}</p>
              <p className="text-[13px] text-[var(--lq-text-dim)]">
                {albumTitle ? 'These stay in this album and will not appear in Photos' : 'Photos and whole folders, up to 1.95 GB each'}
              </p>
            </LiquiGlass>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** Clear glass, so the page reaches the ripple. Its tint and rim are in index.css. */
const NAV_GLASS = { frost: 0, blur: 1, refraction: 70, bezel: 14, specular: 1 } as const;

/** What gives the bar its rippled view of the page. index.css applies it to the glass's backdrop. */
function NavRipple() {
  return (
    <svg aria-hidden="true" width="0" height="0" className="absolute">
      <filter id="nav-ripple" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.045 0.016" numOctaves={1} seed={7} result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale={34} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}

function NavStrip() {
  const [path, navigate] = useLocation();
  const active = activeSection(path) || '/';
  return (
    <div className="nav-strip pointer-events-none fixed inset-x-3 bottom-3 z-30 flex justify-center min-[720px]:bottom-5">
      <NavRipple />
      <TabBar className="lq-round pointer-events-auto" value={active} aria-label="Main" glass={NAV_GLASS}>
        {NAV.map(({ href, label }) => (
          <TabBarItem
            key={href}
            value={href}
            // On the click, not on a change of tab: inside an album or a search, the current tab still has to lead back to its own page.
            onClick={() => {
              if (path !== href) navigate(href);
            }}
            render={<CrystalButton />}
            className="min-w-0 cursor-pointer px-[clamp(2px,3.4vw,32px)]"
          >
            {label}
          </TabBarItem>
        ))}
      </TabBar>
    </div>
  );
}

interface ShellProps {
  account: Account;
  storage: 'telegram' | 'fake';
  onReauth: () => void;
}

export function Shell({ account, storage, onReauth }: ShellProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [path] = useLocation();
  const status = useUploadStatus();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [path]);

  // While an album is open, new files go into it rather than into Photos.
  const openAlbum = /^\/albums\/(\d+)$/.exec(path);
  const uploadAlbumId = openAlbum ? Number(openAlbum[1]) : null;
  const uploadAlbum = useQuery({ queryKey: ['albums', uploadAlbumId], queryFn: () => api.album(uploadAlbumId!), enabled: uploadAlbumId !== null });
  const uploadAlbumTitle = uploadAlbumId !== null ? (uploadAlbum.data?.title ?? null) : null;
  const uploadTarget = useRef(uploadAlbumId);
  uploadTarget.current = uploadAlbumId;

  const addFiles = useRef((files: File[]) => {
    const { added, skipped } = uploader.add(files, uploadTarget.current);
    if (skipped > 0) {
      toast.add({
        title: `${formatCount(skipped, 'file')} skipped`,
        description: added > 0 ? 'Only photos and videos can be stored, so the rest were left out.' : 'Only photos and videos can be stored.',
      });
    }
  }).current;

  const signedOut = () => {
    queryClient.clear();
    window.location.assign('/');
  };

  return (
    <>
      <div className="ambient" aria-hidden="true" />
      <input
        id={FILE_INPUT_ID}
        type="file"
        multiple
        hidden
        accept={ACCEPTED_FILES}
        onChange={(event) => {
          addFiles([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />
      <header className="fixed top-3 right-3 left-3 z-20 flex items-center gap-2.5 min-[720px]:right-5 min-[720px]:left-5">
        <Brand />
        <SearchBox />
        <CrystalButton
          onClick={openFilePicker}
          aria-label={uploadAlbumTitle ? `Upload photos and videos to ${uploadAlbumTitle}` : 'Upload photos and videos'}
          title={uploadAlbumTitle ? `Upload to ${uploadAlbumTitle} only` : undefined}
          className="h-12 flex-none px-[22px] max-[519px]:w-12 max-[519px]:px-0"
        >
          <Upload className="size-4" aria-hidden="true" />
          <span className="max-[519px]:hidden">Upload</span>
        </CrystalButton>
        <UserMenu account={account} onSignedOut={signedOut} />
      </header>
      <main className="pt-[var(--top-h)] pr-3 pb-32 pl-3 min-[720px]:pr-[60px] min-[720px]:pl-5">
        {storage === 'fake' ? (
          <div className="mb-1">
            <DemoBadge />
          </div>
        ) : null}
        {account.needsReauth ? (
          <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl bg-amber-400/20 px-4 py-3 text-[13.5px]">
            <span className="min-w-0 flex-1 font-medium">Telegram ended this session, so uploads are paused. Nothing is lost.</span>
            <Button variant="accent" size="sm" onClick={onReauth}>
              Sign in again
            </Button>
          </div>
        ) : null}
        <AutoBackupBanner needsSignIn={account.needsReauth} />
        {/*
          Opacity only. A transform here, even briefly, would make this the frame of reference for
          every position: fixed element inside the pages.
        */}
        <motion.div key={path} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}>
        <Switch>
          <Route path="/" component={PhotosPage} />
          <Route path="/search" component={SearchPage} />
          <Route path="/favorites" component={FavoritesPage} />
          <Route path="/albums" component={AlbumsPage} />
          <Route path="/albums/:id" component={AlbumPage} />
          <Route path="/trash" component={TrashPage} />
          <Route>
            <div className="py-20 text-center">
              <p className="font-semibold">Page not found</p>
              <Link href="/" className="mt-1 inline-block text-[var(--lq-accent)]">
                Back to your photos
              </Link>
            </div>
          </Route>
        </Switch>
        </motion.div>
      </main>
      <NavStrip />
      <UploadPanel status={status} />
      <DropOverlay onFiles={addFiles} albumTitle={uploadAlbumTitle} />
      <Toaster className="lq-solid max-[1240px]:bottom-[112px]! sm:right-auto sm:left-5 max-sm:right-3 max-sm:left-3" />
    </>
  );
}
