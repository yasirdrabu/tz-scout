import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Dialog } from './Dialog';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Send back
      </button>
      <Dialog open={open} onOpenChange={setOpen} title="Send this account back?" description="It leaves the queue.">
        <button type="button">Send back to source</button>
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('opens named by its title, holds focus and closes with Esc', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Send back' }));
    const dialog = screen.getByRole('dialog', { name: 'Send this account back?' });
    expect(dialog).toHaveAccessibleDescription('It leaves the queue.');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send back' })).toHaveFocus());
  });

  it('has a Close button', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Send back' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
