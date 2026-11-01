import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { FilterPopover, type FilterCategory, type FilterValue } from './FilterPopover';

const CATEGORIES: FilterCategory[] = [
  {
    key: 'practice',
    label: 'Practice',
    pick: 'one',
    options: [
      { value: 'p1', label: 'AI Transformation', count: 5 },
      { value: 'p2', label: 'AI Marketing Studio', count: 2 },
    ],
  },
  {
    key: 'status',
    label: 'Review status',
    pick: 'any',
    options: [
      { value: 'unvetted', label: 'Ready for review', count: 8 },
      { value: 'needs_review', label: 'In review', count: 3 },
    ],
  },
];

function Harness({ initial = {} }: { initial?: FilterValue }) {
  const [value, setValue] = useState<FilterValue>(initial);
  return (
    <FilterPopover
      categories={CATEGORIES}
      value={value}
      onChange={(key, values) => setValue((v) => ({ ...v, [key]: values }))}
      onClear={() => setValue({})}
    />
  );
}

describe('FilterPopover', () => {
  it('shows categories and options with counts, and says nothing is filtered yet', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = screen.getByRole('dialog', { name: 'Filters' });
    expect(within(panel).getByRole('tab', { name: 'Practice' })).toHaveAttribute('aria-selected', 'true');
    expect(within(panel).getByRole('group', { name: 'Practice · pick one' })).toBeInTheDocument();
    expect(within(panel).getByRole('radio', { name: 'AI Transformation 5' })).not.toBeChecked();
    expect(panel).toHaveTextContent('Nothing filtered yet');
    await user.hover(within(panel).getByRole('tab', { name: 'Review status' }));
    expect(within(panel).getByRole('group', { name: 'Review status · pick any' })).toBeInTheDocument();
    expect(within(panel).getByRole('checkbox', { name: 'In review 3' })).toBeInTheDocument();
  });

  it('picks one per radio category and any per checkbox category, with a count and pills', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = screen.getByRole('dialog', { name: 'Filters' });
    await user.click(within(panel).getByRole('radio', { name: 'AI Transformation 5' }));
    await user.click(within(panel).getByRole('radio', { name: 'AI Marketing Studio 2' }));
    expect(within(panel).getByRole('radio', { name: 'AI Transformation 5' })).not.toBeChecked();
    await user.click(within(panel).getByRole('tab', { name: 'Review status' }));
    await user.click(within(panel).getByRole('checkbox', { name: 'Ready for review 8' }));
    await user.click(within(panel).getByRole('checkbox', { name: 'In review 3' }));
    expect(panel).toHaveTextContent('3 filters on');
    expect(within(panel).getByRole('tab', { name: 'Review status 2 picked' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter 3 on' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Remove Practice AI Marketing Studio' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove Review status In review' }));
    expect(screen.queryByRole('button', { name: 'Remove Review status In review' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Filter 2 on' })).toBeInTheDocument();
  });

  it('a pill reopens its category, a checked radio clears on click, and Clear all clears everything', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ practice: ['p1'], status: ['unvetted'] }} />);
    await user.click(screen.getByRole('button', { name: 'Change Review status Ready for review' }));
    const panel = screen.getByRole('dialog', { name: 'Filters' });
    expect(within(panel).getByRole('tab', { name: 'Review status 1 picked' })).toHaveAttribute('aria-selected', 'true');
    await user.click(within(panel).getByRole('tab', { name: 'Practice 1 picked' }));
    await user.click(within(panel).getByRole('radio', { name: 'AI Transformation 5' }));
    expect(panel).toHaveTextContent('1 filter on');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(screen.getByRole('button', { name: 'Filter' })).toBeInTheDocument();
  });
});
