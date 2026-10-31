import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';

describe('Button', () => {
  it('renders a type=button with its label, variant and size', () => {
    render(
      <Button variant="dark" size="sm">
        Assign
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Assign' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button.className).toMatch(/dark/);
    expect(button.className).toMatch(/sm/);
  });

  it('is primary and md by default', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.className).toMatch(/primary/);
    expect(button.className).toMatch(/md/);
  });

  it('does not fire when disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
