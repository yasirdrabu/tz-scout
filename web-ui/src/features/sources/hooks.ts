import { useQueryClient } from '@tanstack/react-query';
import { useRun } from '../settings/shared';
import { patchSource, type SourceDetail } from './api';

export const pauseToast = (name: string) => `${name} paused. Anything it sends is refused until you resume it.`;
export const resumeToast = (name: string) => `${name} resumed. New accounts will reach review again.`;

/** Refreshes everything the Source page and Sources show after a change. */
export function useRefreshSources(tenant: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['sources', tenant] });
}

/** Pause or resume, with the toasts (Decision 9). */
export function usePause(tenant: string, s: SourceDetail | undefined) {
  const { run, busy } = useRun();
  const refresh = useRefreshSources(tenant);
  const toggle = async () => {
    if (!s) return;
    const paused = s.status === 'paused';
    await run(async () => {
      await patchSource(tenant, s.id, { status: paused ? 'active' : 'paused' });
      await refresh();
    }, paused ? resumeToast(s.name) : pauseToast(s.name));
  };
  return { toggle, busy };
}
