import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useId } from 'react';
import { hasScope } from '../../../api/me';
import { useSearchText } from '../../../lib/useSearchText';
import { Button } from '../../../ui/Button';
import { EmptyState } from '../../../ui/EmptyState';
import { Field } from '../../../ui/Field';
import type { TabProps } from '../SettingsScreen';
import { LoadFailed, LoadingRows } from '../shared';
import styles from '../Settings.module.css';
import { membersQuery } from '../members/api';
import { AREAS, auditQuery } from './api';
import { AuditTable } from './AuditTable';

const route = getRouteApi('/t/$tenant/settings/$tab');

type Filters = { q?: string; area?: string; who?: string };

/** §21g Audit log: search, Area and Who filters (in the URL, C10), newest first with Show more. */
export function AuditTab({ me, tenant }: TabProps) {
  const searchId = useId();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const q = search.q ?? '';
  const area = search.area ?? '';
  const who = search.who ?? '';
  // Typing replaces the history entry; picking a filter adds one, so Back undoes it.
  const setFilter = (patch: Filters, replace = false) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  const [text, setText] = useSearchText(q, (next) => setFilter({ q: next || undefined }, true));
  const log = useInfiniteQuery(auditQuery(tenant, { q, area, who }));
  // Who lists the workspace's members, for people who may read the members list.
  const canListPeople = hasScope(me, 'members:read') || hasScope(me, 'members:manage');
  const people = useQuery({ ...membersQuery(tenant), enabled: canListPeople });
  const entries = log.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <p className={styles.intro}>
        Every change to members, keys, integrations, settings, sources and tenants, and every sign-in. Kept for 2 years. Nobody can
        edit or delete an entry.
      </p>
      <div className={styles.toolbar}>
        <label htmlFor={searchId} className="sr-only">
          Find an action, person or target
        </label>
        <input
          id={searchId}
          type="search"
          className={`input ${styles.search}`}
          placeholder="Find an action, person or target"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Field label="Area">
          {(c) => (
            <select {...c} className="input" value={area} onChange={(e) => setFilter({ area: e.target.value || undefined })}>
              <option value="">Every area</option>
              {AREAS.map((a) => (
                <option key={a.area} value={a.area}>
                  {a.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        {canListPeople && (
          <Field label="Who">
            {(c) => (
              <select {...c} className="input" value={who} onChange={(e) => setFilter({ who: e.target.value || undefined })}>
                <option value="">Everyone</option>
                {(people.data ?? []).map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
      </div>
      {log.isPending ? (
        <LoadingRows>Loading the audit log</LoadingRows>
      ) : log.isError ? (
        <LoadFailed title="The audit log didn't load" error={log.error} onRetry={() => void log.refetch()} />
      ) : entries.length === 0 ? (
        <EmptyState title="No events match">Try other words, or another area or person.</EmptyState>
      ) : (
        <AuditTable
          entries={entries}
          more={
            log.hasNextPage && (
              <Button size="sm" variant="secondary" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
                Show more
              </Button>
            )
          }
        />
      )}
    </>
  );
}
