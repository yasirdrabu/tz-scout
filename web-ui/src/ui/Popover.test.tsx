import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Popover } from './Popover';

describe('Popover', () => {
  it('opens from its trigger, is named and closes with Esc', async () => {
    const user = userEvent.setup();
    render(
      <Popover trigger={<button type="button">Filter</button>} label="Filters">
        <p>Nothing filtered yet</p>
      </Popover>,
    );
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    expect(screen.getByRole('dialog', { name: 'Filters' })).toHaveTextContent('Nothing filtered yet');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
