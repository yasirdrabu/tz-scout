import { act, render, screen } from '@testing-library/react';
import { ToastProvider, useToast, TOAST_MS } from './Toast';

function Trigger({ message }: { message: string }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.show(message)}>
      {message}
    </button>
  );
}

describe('Toast', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows one message at a time and hides after 3.5 s', () => {
    render(
      <ToastProvider>
        <Trigger message="Assigned to Ash Patel." />
        <Trigger message="Sent back." />
      </ToastProvider>,
    );
    act(() => screen.getByRole('button', { name: 'Assigned to Ash Patel.' }).click());
    expect(screen.getByRole('status')).toHaveTextContent('Assigned to Ash Patel.');

    act(() => screen.getByRole('button', { name: 'Sent back.' }).click());
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Sent back.');
    expect(screen.getByRole('status')).not.toHaveTextContent('Assigned');

    act(() => vi.advanceTimersByTime(TOAST_MS - 1));
    expect(screen.getByRole('status')).toHaveTextContent('Sent back.');
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('lasts 3.5 seconds', () => {
    expect(TOAST_MS).toBe(3500);
  });

  it('throws outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Trigger message="x" />)).toThrow(/ToastProvider/);
  });
});
