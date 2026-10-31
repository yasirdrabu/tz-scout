import { render, screen } from '@testing-library/react';
import { FormatProvider, useFormat } from './useFormat';

function Sample() {
  const f = useFormat();
  return (
    <p>
      {f.money(150000)} at {f.dateTime('2026-10-26T14:48:00Z')}
    </p>
  );
}

describe('useFormat', () => {
  it('formats in the workspace currency and timezone', () => {
    render(
      <FormatProvider currency="EUR" timeZone="Europe/Berlin">
        <Sample />
      </FormatProvider>,
    );
    expect(screen.getByText('€1,500 at Oct 26, 3:48 PM')).toBeInTheDocument();
  });

  it('keeps the defaults for missing values', () => {
    render(
      <FormatProvider currency={undefined} timeZone="America/New_York">
        <Sample />
      </FormatProvider>,
    );
    expect(screen.getByText('$1,500 at Oct 26, 10:48 AM')).toBeInTheDocument();
  });
});
