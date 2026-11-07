import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Images, MoreVertical, Plus, SearchX, Star, Trash2, Upload } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import { api, autoBackup } from '@/api';
import { useMedia } from '@/hooks/useMedia';
import { ConfirmDialog, type ConfirmRequest } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Tip } from '@/components/IconAction';
import { LibraryView } from '@/components/LibraryView';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions, DialogContent, DialogDismiss, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { usePhotoActions } from '@/hooks/usePhotoActions';
import { formatCount } from '@/lib/format';
import { openFilePicker } from '@/components/Shell';

function PageHeading({ title, children, subtitle }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 pt-2">
      <div className="min-w-0 flex-1">
        <h1 className="text-[26px] leading-tight font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-[13px] text-[var(--lq-text-dim)]">{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}

export function PhotosPage() {
  const [, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const addTo = Number(params.get('addTo')) || null;
  const actions = usePhotoActions();
  const album = useQuery({ queryKey: ['albums', addTo], queryFn: () => api.album(addTo!), enabled: addTo !== null });

  return (
    <LibraryView
      query={{}}
      mode="library"
      heading={
        addTo ? (
          <PageHeading title={`Add photos to ${album.data?.title ?? 'album'}`} subtitle="Tap the photos you want, then add them.">
            <Link href={`/albums/${addTo}`} className="text-[13.5px] font-semibold text-[var(--lq-accent)]">
              Cancel
            </Link>
          </PageHeading>
        ) : null
      }
      picker={
        addTo
          ? {
              label: (count) => `Add ${formatCount(count, 'photo')}`,
              onPick: (ids) => void actions.addToAlbum(addTo, ids, album.data?.title ?? 'album').then(() => navigate(`/albums/${addTo}`)),
            }
          : undefined
      }
      empty={
        <EmptyState icon={<Images className="size-9" aria-hidden="true" />} title="Your photos will show up here">
          <p>{autoBackup.available ? 'Turn on auto backup, or choose photos to upload. They go into your own Telegram at full quality.' : 'Drag photos or whole folders anywhere on this page, or choose them from your computer. They go into your own Telegram at full quality.'}</p>
          <div className="mt-4 flex justify-center">
            <Button variant="accent" onClick={openFilePicker}>
              <Upload className="size-4" aria-hidden="true" /> Upload photos
            </Button>
          </div>
        </EmptyState>
      }
    />
  );
}

export function SearchPage() {
  const q = new URLSearchParams(useSearch()).get('q') ?? '';
  return (
    <LibraryView
      query={{ q }}
      mode="library"
      heading={<PageHeading title={q ? `Results for "${q}"` : 'Search'} />}
      empty={
        <EmptyState icon={<SearchX className="size-9" aria-hidden="true" />} title={q ? 'No matching photos' : 'Search your photos'}>
          <p>Search by file name, camera, or date. Try "2023", "july", "canon" or "IMG_1042".</p>
        </EmptyState>
      }
    />
  );
}

export function FavoritesPage() {
  return (
    <LibraryView
      query={{ view: 'favorites' }}
      mode="library"
      heading={<PageHeading title="Favorites" />}
      empty={
        <EmptyState icon={<Star className="size-9" aria-hidden="true" />} title="No favorites yet">
          <p>Star the photos you love most and they will gather here.</p>
        </EmptyState>
      }
    />
  );
}

export function TrashPage() {
  const actions = usePhotoActions();
  const library = useQuery({ queryKey: ['library'], queryFn: api.library });
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const trashCount = library.data?.stats.trash ?? 0;

  return (
    <>
      <LibraryView
        query={{ view: 'trash' }}
        mode="trash"
          heading={
          <PageHeading title="Trash" subtitle={`Photos here are deleted forever after ${library.data?.trashRetentionDays ?? 30} days, from Telegram too.`}>
            {trashCount > 0 ? (
              <Button
                variant="danger"
                size="sm"
                onClick={() =>
                  setConfirm({
                    title: 'Empty the Trash?',
                    description: `${formatCount(trashCount, 'photo')} will be removed from your Telegram for good. This cannot be undone.`,
                    confirm: 'Empty Trash',
                    onConfirm: () => api.emptyTrash().then(actions.refresh, actions.fail),
                  })
                }
              >
                <Trash2 className="size-3.5" aria-hidden="true" /> Empty Trash
              </Button>
            ) : null}
          </PageHeading>
        }
        empty={
          <EmptyState icon={<Trash2 className="size-9" aria-hidden="true" />} title="Trash is empty">
            <p>Photos you remove wait here before they are deleted for good.</p>
          </EmptyState>
        }
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}

function NewAlbumDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogTitle>New album</DialogTitle>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void api.createAlbum(title).then(
              ({ id }) => {
                void queryClient.invalidateQueries({ queryKey: ['albums'] });
                setTitle('');
                onClose();
                navigate(`/albums/${id}`);
              },
              (err: Error) => setError(err.message),
            );
          }}
        >
          <Input className="mt-4" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Album name" aria-label="Album name" />
          {error ? <p role="alert" className="mt-2 text-[13px] text-[var(--lq-danger-text)]">{error}</p> : null}
          <DialogActions>
            <DialogDismiss>Cancel</DialogDismiss>
            <Button type="submit" variant="accent" disabled={!title.trim()}>
              Create
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The two ways in: photos already in the library stay there too, while new uploads live only in the album. */
function AddPhotosMenu({ albumId }: { albumId: number }) {
  const [, navigate] = useLocation();
  return (
    <Menu>
      <MenuTrigger render={<Button variant="accent" size="sm" />}>
        <Plus className="size-3.5" aria-hidden="true" /> Add photos
      </MenuTrigger>
      <MenuContent align="end" className="lq-solid" glass={{ frost: 1, blur: 6 }}>
        <MenuItem onClick={() => navigate(`/?addTo=${albumId}`)}>
          <Images className="size-4 flex-none" aria-hidden="true" />
          <span>
            <span className="block">From your library</span>
            <span className="block text-[12px] font-normal text-[var(--lq-text-dim)]">They stay in Photos too</span>
          </span>
        </MenuItem>
        <MenuItem onClick={openFilePicker}>
          <Upload className="size-4 flex-none" aria-hidden="true" />
          <span>
            <span className="block">Upload new photos</span>
            <span className="block text-[12px] font-normal text-[var(--lq-text-dim)]">Only in this album, not in Photos</span>
          </span>
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function AlbumCover({ id }: { id: number }) {
  const { url } = useMedia(id, 'thumb');
  return url ? <img src={url} alt="" className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" /> : null;
}

export function AlbumsPage() {
  const albums = useQuery({ queryKey: ['albums'], queryFn: api.albums });
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeading title="Albums">
        <Button variant="accent" size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" aria-hidden="true" /> New album
        </Button>
      </PageHeading>
      {albums.data?.length === 0 ? (
        <EmptyState icon={<Images className="size-9" aria-hidden="true" />} title="No albums yet">
          <p>Create one here, or select some photos and choose "Add to album".</p>
        </EmptyState>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-4 gap-y-6 pt-2">
          {albums.data?.map((album) => (
            <motion.li key={album.id} whileTap={{ scale: 0.97 }}>
              <Link href={`/albums/${album.id}`} className="group block rounded-2xl">
                <div className="aspect-square overflow-hidden rounded-2xl bg-[var(--app-tile)]">
                  {album.coverId ? (
                    <AlbumCover id={album.coverId} />
                  ) : (
                    <div className="grid size-full place-items-center text-[var(--lq-text-dim)]">
                      <Images className="size-9" aria-hidden="true" />
                    </div>
                  )}
                </div>
                <p className="mt-2 truncate text-[14px] font-semibold">{album.title}</p>
                <p className="text-[12.5px] text-[var(--lq-text-dim)]">{formatCount(album.photoCount, 'item')}</p>
              </Link>
            </motion.li>
          ))}
        </ul>
      )}
      <NewAlbumDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

export function AlbumPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const actions = usePhotoActions();
  const album = useQuery({ queryKey: ['albums', id], queryFn: () => api.album(id) });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  if (album.isError) {
    return (
      <EmptyState icon={<SearchX className="size-9" aria-hidden="true" />} title="This album doesn't exist">
        <Link href="/albums" className="font-semibold text-[var(--lq-accent)]">
          Back to albums
        </Link>
      </EmptyState>
    );
  }

  const title = album.data?.title ?? '';
  const onlyHere = album.data?.onlyHereCount ?? 0;
  const subtitle = album.data ? `${formatCount(album.data.photoCount, 'item')}${onlyHere > 0 ? ` · ${onlyHere.toLocaleString()} only in this album` : ''}` : undefined;

  return (
    <>
      <LibraryView
        query={{ album: id }}
        mode="album"
        albumId={id}
          heading={
          <>
            <Link href="/albums" className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-[var(--lq-text-dim)] hover:text-[var(--lq-text)]">
              <ArrowLeft className="size-3.5" aria-hidden="true" /> Albums
            </Link>
            <PageHeading title={title || ' '} subtitle={subtitle}>
              <AddPhotosMenu albumId={id} />
              <Menu>
                <Tip label="More options">
                  <MenuTrigger aria-label="More options" className="grid size-9 cursor-pointer place-items-center rounded-full hover:bg-[var(--app-tile)]">
                    <MoreVertical className="size-[18px]" aria-hidden="true" />
                  </MenuTrigger>
                </Tip>
                <MenuContent align="end" className="lq-solid" glass={{ frost: 1, blur: 6 }}>
                  <MenuItem onClick={() => setRenaming(title)}>Rename album</MenuItem>
                  <MenuItem
                    variant="danger"
                    onClick={() =>
                      setConfirm({
                        title: `Delete "${title}"?`,
                        description:
                          onlyHere > 0
                            ? `${formatCount(onlyHere, 'photo')} uploaded only to this album will move to Trash. Restoring one puts it in Photos. Anything from your library stays there.`
                            : 'Only the album goes away. The photos in it stay in your library and in Telegram.',
                        confirm: 'Delete album',
                        onConfirm: () =>
                          api.deleteAlbum(id).then(() => {
                            actions.refresh();
                            navigate('/albums');
                          }, actions.fail),
                      })
                    }
                  >
                    Delete album
                  </MenuItem>
                </MenuContent>
              </Menu>
            </PageHeading>
          </>
        }
        empty={
          <EmptyState icon={<Images className="size-9" aria-hidden="true" />} title="This album is empty">
            <p>Add photos you already have, or upload new ones. New uploads stay in this album and do not appear in Photos.</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button variant="accent" onClick={openFilePicker}>
                <Upload className="size-4" aria-hidden="true" /> Upload new photos
              </Button>
              <Button onClick={() => navigate(`/?addTo=${id}`)}>
                <Images className="size-4" aria-hidden="true" /> From your library
              </Button>
            </div>
          </EmptyState>
        }
      />
      <Dialog open={renaming !== null} onOpenChange={(next) => !next && setRenaming(null)}>
        <DialogContent>
          <DialogTitle>Rename album</DialogTitle>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (renaming === null) return;
              void api.updateAlbum(id, { title: renaming }).then(() => {
                void queryClient.invalidateQueries({ queryKey: ['albums'] });
                setRenaming(null);
              }, actions.fail);
            }}
          >
            <Input className="mt-4" autoFocus value={renaming ?? ''} onChange={(e) => setRenaming(e.target.value)} aria-label="Album name" />
            <DialogActions>
              <DialogDismiss>Cancel</DialogDismiss>
              <Button type="submit" variant="accent" disabled={!renaming?.trim()}>
                <Check className="size-3.5" aria-hidden="true" /> Save
              </Button>
            </DialogActions>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
