import { render, screen } from '@testing-library/react';
import { Avatar, initialsOf } from './Avatar';

describe('Avatar', () => {
  it('shows initials and is named by the person', () => {
    render(<Avatar name="Dana Whitfield" />);
    expect(screen.getByRole('img', { name: 'Dana Whitfield' })).toHaveTextContent('DW');
  });

  it('makes initials from one or many names', () => {
    expect(initialsOf('dana')).toBe('D');
    expect(initialsOf('Ash  van Patel')).toBe('AP');
    expect(initialsOf('  ')).toBe('?');
  });
});
