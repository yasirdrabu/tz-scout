import type { UseQueryResult } from '@tanstack/react-query';
import { useFormat } from '../../../lib/useFormat';
import { EmptyState } from '../../../ui/EmptyState';
import table from '../../../ui/Table.module.css';
import { LoadFailed, LoadingRows } from '../../settings/shared';
import type { BatchRow } from '../api';

type Props = { batches: UseQueryResult<{ data: BatchRow[]; next_cursor: string | null; total: number }> };

/** The source's batches (`GET /batches?source_id=`) in a plain table; the shared Batches table replaces it with §13. */
export function BatchesTab({ batches }: Props) {
  const f = useFormat();
  if (batches.isPending) return <LoadingRows>Loading batches</LoadingRows>;
  if (batches.isError) return <LoadFailed title="Batches didn't load" error={batches.error} onRetry={() => void batches.refetch()} />;
  const rows = batches.data.data;
  if (rows.length === 0) return <EmptyState title="No batches">Batches this source sends or imports will show here.</EmptyState>;
  return (
    <div className={table.wrap}>
      <table className={table.table}>
        <thead>
          <tr>
            <th scope="col">Batch</th>
            <th scope="col">Run date</th>
            <th scope="col" className={table.num}>
              Accounts
            </th>
            <th scope="col" className={table.num}>
              Resolved
            </th>
            <th scope="col" className={table.num}>
              Rejected
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id}>
              <td>
                {b.name}
                <div className={table.muted}>{b.id}</div>
              </td>
              <td>{f.date(b.run_at)}</td>
              <td className={table.num}>{f.number(b.item_count)}</td>
              <td className={table.num}>{f.number(b.counts.resolved ?? 0)}</td>
              <td className={table.num}>{f.number(b.counts.rejected ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
