import { render, screen } from '@testing-library/react';
import { X } from 'lucide-react';
import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('takes its accessible name from the label', () => {
    render(
      <IconButton label="Close">
        <X />
      </IconButton>,
    );
    expect(screen.getByRole('button', { name: 'Close' })).toHaveAttribute('type', 'button');
  });
});
