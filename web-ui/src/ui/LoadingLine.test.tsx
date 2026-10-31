import { render, screen } from '@testing-library/react';
import { LoadingLine } from './LoadingLine';

describe('LoadingLine', () => {
  it('says what is loading in a status region', () => {
    render(<LoadingLine>Loading the review queue</LoadingLine>);
    expect(screen.getByRole('status')).toHaveTextContent('Loading the review queue');
  });
});
