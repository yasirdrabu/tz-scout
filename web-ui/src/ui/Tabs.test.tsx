import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Tabs } from './Tabs';

function Harness() {
  const [value, setValue] = useState('all');
  return (
    <Tabs
      label="Member status"
      tabs={[
        { id: 'all', label: 'All' },
        { id: 'active', label: 'Active' },
        { id: 'invited', label: 'Invited' },
      ]}
      value={value}
      onChange={setValue}
    >
      <p>Showing {value}</p>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('selects by click and shows the panel named by the tab', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Member status' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Invited' }));
    expect(screen.getByRole('tab', { name: 'Invited' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Invited' })).toHaveTextContent('Showing invited');
  });

  it('moves with the arrow keys, Home and End', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: 'All' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Active' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Active' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Invited' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'All' })).toHaveFocus();
    await user.keyboard('{End}{Home}');
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
  });
});
