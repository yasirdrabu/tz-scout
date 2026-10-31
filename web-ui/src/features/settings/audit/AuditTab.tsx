import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { hasScope } from '../../../api/me';
import { Button } from '../../../ui/Button';
import { EmptyState } from '../../../ui/EmptyState';
import { Field } from '../../../ui/Field';
import type { TabProps } from '../SettingsScreen';
import { LoadFailed, LoadingRows } from '../shared';
import styles from '../Settings.module.css';
import { membersQuery } from '../members/api';
import { AREAS, auditQuery } from './api';
import { AuditTable } from './AuditTable';

const SEARCH_DELAY_MS = 300;

/** The search box's text, settled after the person stops typing. */
function useSettled(value: string) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [value]);
  return settled;
}

/** §21g Audit log: search, Area and Who filters, newest first with Show more. */
export function AuditTab({ me, tenant }: TabProps) {
  const searchId = useId();
  const [text, setText] = useState('');
  const [area, setArea] = useState('');
  const [who, setWho] = useState('');
  const q = useSettled(text);
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
            <select {...c} className="input" value={area} onChange={(e) => setArea(e.target.value)}>
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
              <select {...c} className="input" value={who} onChange={(e) => setWho(e.target.value)}>
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
