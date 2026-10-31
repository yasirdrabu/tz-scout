import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from './Menu';

describe('Menu', () => {
  it('opens by keyboard and runs the chosen item', async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn();
    render(
      <Menu trigger={<button type="button">Dana Whitfield</button>}>
        <MenuLabel>dana@taazaa.com</MenuLabel>
        <MenuItem onSelect={() => undefined}>Profile</MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={onSignOut}>Sign out</MenuItem>
      </Menu>,
    );
    screen.getByRole('button', { name: 'Dana Whitfield' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu', { name: 'Dana Whitfield' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
