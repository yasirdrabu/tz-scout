import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorState } from './ErrorState';

describe('ErrorState', () => {
  it('shows what failed, a retry and the error ref', async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState title="The review queue didn't load" errorRef="q-7f31c2" onRetry={onRetry}>
        Nothing was lost.
      </ErrorState>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent("The review queue didn't load");
    expect(screen.getByText('Nothing was lost.')).toBeInTheDocument();
    expect(screen.getByText('Error ref q-7f31c2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('leaves out the retry and ref when not given', () => {
    render(<ErrorState title="Something went wrong" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/Error ref/)).toBeNull();
  });
});
