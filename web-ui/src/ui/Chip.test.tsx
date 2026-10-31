import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Chip } from './Chip';

describe('Chip', () => {
  it('shows its label', () => {
    render(<Chip>Tier Act now</Chip>);
    expect(screen.getByText('Tier Act now')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('has a named remove button when removable', async () => {
    const onRemove = vi.fn();
    render(<Chip onRemove={onRemove}>Tier Act now</Chip>);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Tier Act now' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
