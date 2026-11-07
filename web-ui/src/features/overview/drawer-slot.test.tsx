import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { OverviewScreen } from './OverviewScreen';
import { serveOverview } from './testing';

vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  getRouteApi: () => ({ useParams: () => ({ tenant: 'taazaa' }) }),
}));

describe('Overview drawer slot', () => {
  it('hands the selection to the drawer and clears it on close', async () => {
    serveOverview();
    const seen: unknown[] = [];
    let close: () => void = () => {};
    const drawer = (selection: unknown, onClose: () => void): ReactNode => {
      seen.push(selection);
      close = onClose;
      return <p>{selection ? 'drawer open' : 'drawer closed'}</p>;
    };
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <OverviewScreen drawer={drawer} />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: /^Reviewed/ }));
    expect(seen.at(-1)).toEqual({ key: 'stage', scope: { stage: 'reviewed' } });
    await userEvent.click(screen.getByRole('button', { name: /Pipeline value/ }));
    expect(seen.at(-1)).toEqual({ key: 'pipeline_value' });
    expect(screen.getByText('drawer open')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Rejected/ }));
    expect(seen.at(-1)).toEqual({ key: 'exit', scope: { stage: 'rejected' } });
    close();
    expect(await screen.findByText('drawer closed')).toBeInTheDocument();
    expect(seen.at(-1)).toBeNull();
  });
});
