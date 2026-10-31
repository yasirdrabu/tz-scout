import { render, screen } from '@testing-library/react';
import { Card } from './Card';

describe('Card', () => {
  it('is a region named by its title', () => {
    render(<Card title="Scout's recommendation">Body</Card>);
    expect(screen.getByRole('region', { name: "Scout's recommendation" })).toHaveTextContent('Body');
  });

  it('renders without a title', () => {
    render(<Card>Body</Card>);
    expect(screen.getByText('Body')).toBeInTheDocument();
    expect(screen.queryByRole('region')).toBeNull();
  });
});
