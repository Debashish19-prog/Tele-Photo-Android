import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, autoBackup, downloadPhotos } from '@/api';
import { useToast } from '@/components/ui/toast';
import { formatCount } from '@/lib/format';

/** The things you can do to photos, each with its feedback and refresh in one place. */
export function usePhotoActions() {
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMemo(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['photos'] });
      void queryClient.invalidateQueries({ queryKey: ['photo'] });
      void queryClient.invalidateQueries({ queryKey: ['albums'] });
      void queryClient.invalidateQueries({ queryKey: ['upload-status'] });
      void queryClient.invalidateQueries({ queryKey: ['library'] });
    };

    const fail = (err: unknown) => {
      toast.add({ title: 'That did not work', description: err instanceof Error ? err.message : undefined, type: 'error' });
      refresh();
    };

    return {
      refresh,
      fail,
      setFavorite: (ids: number[], favorite: boolean) => api.setFavorite(ids, favorite).then(refresh, fail),

      trash: (ids: number[]) =>
        api.setTrashed(ids, true).then(() => {
          refresh();
          toast.add({
            title: `${formatCount(ids.length, 'photo')} moved to Trash`,
            actionProps: { children: 'Undo', onClick: () => void api.setTrashed(ids, false).then(refresh, fail) },
          });
        }, fail),

      restore: (ids: number[]) =>
        api.setTrashed(ids, false).then(() => {
          refresh();
          toast.add({ title: `${formatCount(ids.length, 'photo')} restored` });
        }, fail),

      deleteForever: (ids: number[]) =>
        api.deleteForever(ids).then(({ deleted, skipped }) => {
          refresh();
          toast.add({
            title: `${formatCount(deleted, 'photo')} deleted forever`,
            description: skipped > 0 ? `${formatCount(skipped, 'photo')} still uploading. Try those again in a moment.` : undefined,
          });
        }, fail),

      addToAlbum: (albumId: number, ids: number[], title: string) =>
        api.addToAlbum(albumId, ids).then(() => {
          refresh();
          toast.add({ title: `Added ${formatCount(ids.length, 'photo')} to ${title}` });
        }, fail),

      removeFromAlbum: (albumId: number, ids: number[]) =>
        api.removeFromAlbum(albumId, ids).then(({ movedToPhotos }) => {
          refresh();
          if (movedToPhotos > 0) {
            toast.add({
              title: `${formatCount(movedToPhotos, 'photo')} moved to Photos`,
              description: 'Uploaded only to this album, so removing it from here put it in your library.',
            });
          }
        }, fail),

      createAlbumWith: (title: string, ids: number[]) =>
        api.createAlbum(title, ids).then(() => {
          refresh();
          toast.add({ title: `Added ${formatCount(ids.length, 'photo')} to ${title}` });
        }, fail),

      download: (ids: number[]) => {
        if (ids.length > 2000) {
          toast.add({ title: 'Too many at once', description: 'You can download up to 2,000 photos at a time.', type: 'error' });
          return;
        }
        void downloadPhotos(ids).catch(fail);
        toast.add(
          ids.length > 1
            ? { title: `Preparing ${formatCount(ids.length, 'photo')}`, description: autoBackup.available ? 'They are fetched from Telegram as the zip is built, and saved to Downloads.' : 'They are fetched from Telegram as the zip is built. Keep this tab open.' }
            : { title: 'Getting the original from Telegram', ...(autoBackup.available ? { description: 'It will be saved to Downloads.' } : {}) },
        );
      },
    };
  }, [queryClient, toast]);
}
