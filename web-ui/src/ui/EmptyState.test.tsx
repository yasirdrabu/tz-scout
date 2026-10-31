import { render, screen } from '@testing-library/react';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('shows a heading, the text and actions', () => {
    render(
      <EmptyState title="The queue is clear" actions={<button type="button">Import a list</button>}>
        New accounts land here.
      </EmptyState>,
    );
    expect(screen.getByRole('heading', { name: 'The queue is clear' })).toBeInTheDocument();
    expect(screen.getByText('New accounts land here.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import a list' })).toBeInTheDocument();
  });
});
