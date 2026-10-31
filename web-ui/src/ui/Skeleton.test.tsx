import { render } from '@testing-library/react';
import { Skeleton } from './Skeleton';

describe('Skeleton', () => {
  it('is hidden from assistive tech and takes a size', () => {
    const { container } = render(<Skeleton width="70%" height={10} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el.style.width).toBe('70%');
    expect(el.style.height).toBe('10px');
  });
});
