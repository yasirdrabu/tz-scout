import { render, screen } from '@testing-library/react';
import { Pill } from './Pill';

describe('Pill', () => {
  it('shows a status dot and its label in the tone', () => {
    render(<Pill tone="good">In HubSpot</Pill>);
    const pill = screen.getByText('In HubSpot');
    expect(pill.className).toMatch(/good/);
    expect(pill.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('is neutral by default', () => {
    render(<Pill>Sending to HubSpot</Pill>);
    expect(screen.getByText('Sending to HubSpot').className).toMatch(/neutral/);
  });
});
