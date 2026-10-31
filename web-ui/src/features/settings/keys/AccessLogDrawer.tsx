import { Activity } from 'lucide-react';
import { Drawer } from '../../../ui/Drawer';
import { EmptyState } from '../../../ui/EmptyState';
import { canDo, type ApiKey } from './api';

/** The key's access log. Key call logging is its own plan (Decision 20), so this shows the empty state. */
export function AccessLogDrawer({ apiKey, onClose }: { apiKey: ApiKey; onClose: () => void }) {
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={apiKey.name} subtitle={`${apiKey.mask} · ${canDo(apiKey.scopes)}`} width={460}>
      <EmptyState title="No calls yet" icon={<Activity />} note="Scout keeps the last 1,000 calls for each key.">
        They show here the first time this key is used.
      </EmptyState>
    </Drawer>
  );
}
