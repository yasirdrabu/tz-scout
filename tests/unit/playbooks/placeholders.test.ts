import { describe, expect, it } from 'vitest';
import { render } from '@/modules/playbooks/domain/placeholders';

const vars = { 'account.name': 'Acme', 'offer.name': 'Opportunity Map', 'offer.promise': 'a clear AI plan', 'seller.first_name': 'Sam', 'person.first_name': 'Priya' };

describe('render', () => {
  it('fills the known placeholders', () => {
    expect(render('Hi {person.first_name}, {seller.first_name} here about {offer.name} at {account.name}: {offer.promise}.', vars, 'email')).toBe(
      'Hi Priya, Sam here about Opportunity Map at Acme: a clear AI plan.',
    );
  });

  it('says "there" in an email and "the contact" elsewhere when no one is linked', () => {
    const none = { ...vars, 'person.first_name': null };
    expect(render('Hi {person.first_name},', none, 'email')).toBe('Hi there,');
    expect(render('Call {person.first_name}.', none, 'detail')).toBe('Call the contact.');
    const { 'person.first_name': _gone, ...absent } = vars;
    expect(render('Hi {person.first_name},', absent, 'email')).toBe('Hi there,');
  });

  it('keeps an unknown placeholder as written, and a known one with no value', () => {
    expect(render('Hello {foo} and {account.size}', vars, 'email')).toBe('Hello {foo} and {account.size}');
    expect(render('{offer.promise}', { ...vars, 'offer.promise': null }, 'detail')).toBe('{offer.promise}');
  });

  it('does not re-expand placeholders inside a value', () => {
    expect(render('{account.name}', { ...vars, 'account.name': '{offer.name}' }, 'email')).toBe('{offer.name}');
  });
});
