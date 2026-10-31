import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Drawer } from './Drawer';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open Dana
      </button>
      <Drawer open={open} onOpenChange={setOpen} title="Dana Whitfield" subtitle="dana@taazaa.com">
        <button type="button">Suspend</button>
      </Drawer>
    </>
  );
}

describe('Drawer', () => {
  it('opens named by its title, holds focus, closes with Esc and returns focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open Dana' }));
    const drawer = screen.getByRole('dialog', { name: 'Dana Whitfield' });
    expect(drawer).toHaveTextContent('dana@taazaa.com');
    expect(drawer).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Dana' })).toHaveFocus());
  });

  it('closes with its Close button', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open Dana' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
