import { render, screen } from '@testing-library/react';
import { Field } from './Field';

describe('Field', () => {
  it('labels the control and describes it with the hint and error', () => {
    render(
      <Field label="Email addresses" hint="Separate with commas or new lines." error="Add at least one email address.">
        {(control) => <textarea {...control} />}
      </Field>,
    );
    const box = screen.getByRole('textbox', { name: 'Email addresses' });
    expect(box).toHaveAccessibleDescription('Separate with commas or new lines. Add at least one email address.');
    expect(box).toHaveAttribute('aria-invalid', 'true');
  });

  it('is valid without an error', () => {
    render(<Field label="Name">{(control) => <input {...control} />}</Field>);
    expect(screen.getByRole('textbox', { name: 'Name' })).not.toHaveAttribute('aria-invalid');
  });
});
