import { render, screen } from '@testing-library/react';
import { Badge } from './Badge';

describe('Badge', () => {
  it('shows the count and says what it counts', () => {
    render(<Badge count={11} label="accounts waiting" />);
    expect(screen.getByText('11')).toBeInTheDocument();
    expect(screen.getByText('accounts waiting')).toHaveClass('sr-only');
  });

  it('caps large counts', () => {
    render(<Badge count={1200} label="accounts waiting" />);
    expect(screen.getByText('999+')).toBeInTheDocument();
  });
});
