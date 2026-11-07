import { useQuery } from '@tanstack/react-query';
import { autoBackup } from '@/api';

const BUSY = new Set(['checking', 'backing-up']);

/** Follows automatic backup. Quick while it is working, as the numbers are moving. */
export function useAutoBackup() {
  return useQuery({
    queryKey: ['auto-backup'],
    queryFn: autoBackup.state,
    enabled: autoBackup.available,
    refetchInterval: (q) => (q.state.data && BUSY.has(q.state.data.phase) ? 1000 : 5000),
  });
}
