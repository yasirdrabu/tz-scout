import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('asks, names the action and cancels', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Remove Ash Patel?"
        description="Their 3 open accounts go back to the review queue."
        confirmLabel="Remove"
        onConfirm={onConfirm}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Remove Ash Patel?' });
    expect(dialog).toHaveAccessibleDescription('Their 3 open accounts go back to the review queue.');
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('disables both buttons while busy', () => {
    render(<ConfirmDialog open onOpenChange={() => undefined} title="Revoke?" description="It stops working." confirmLabel="Revoke" onConfirm={() => undefined} busy />);
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});
