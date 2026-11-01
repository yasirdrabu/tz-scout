import type { UseInfiniteQueryResult, InfiniteData } from '@tanstack/react-query';
import { Button } from '../../../ui/Button';
import { EmptyState } from '../../../ui/EmptyState';
import type { BatchesPage } from '../../batches/api';
import { BatchesTable } from '../../batches/BatchesTable';
import { LoadFailed, LoadingRows } from '../../settings/shared';

type Props = { tenant: string; batches: UseInfiniteQueryResult<InfiniteData<BatchesPage>>; canRetry: boolean };

/** The source's batches (`GET /batches?source_id=`) in the shared §13 table. */
export function BatchesTab({ tenant, batches, canRetry }: Props) {
  if (batches.isPending) return <LoadingRows>Loading batches</LoadingRows>;
  if (batches.isError) return <LoadFailed title="Batches didn't load" error={batches.error} onRetry={() => void batches.refetch()} />;
  const rows = batches.data.pages.flatMap((p) => p.data);
  if (rows.length === 0) return <EmptyState title="No batches">Batches this source sends or imports will show here.</EmptyState>;
  return (
    <>
      <BatchesTable tenant={tenant} rows={rows} canRetry={canRetry} />
      {batches.hasNextPage && (
        <Button variant="secondary" size="sm" disabled={batches.isFetchingNextPage} onClick={() => void batches.fetchNextPage()}>
          Show more
        </Button>
      )}
    </>
  );
}
