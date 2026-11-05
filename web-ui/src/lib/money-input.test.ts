import { centsToInput, parseMoney, parseMoneyInput } from './money-input';

describe('money input', () => {
  it('reads USD amounts with cents and grouping', () => {
    expect(parseMoneyInput('12.50', 'USD')).toBe(1250);
    expect(parseMoneyInput('1,250.50', 'USD')).toBe(125050);
    expect(parseMoneyInput('$12', 'USD')).toBe(1200);
    expect(parseMoneyInput('0', 'USD')).toBe(0);
  });

  it('refuses exponents, stray text and too many decimals', () => {
    expect(parseMoney('1e3', 'USD')).toEqual({ error: 'Enter a number.' });
    expect(parseMoney('abc', 'USD')).toEqual({ error: 'Enter a number.' });
    expect(parseMoney('-5', 'USD')).toEqual({ error: 'Enter a number.' });
    expect(parseMoney('1.234', 'USD')).toEqual({ error: 'Use at most 2 decimal places.' });
    expect(parseMoney('10.5', 'JPY')).toEqual({ error: 'Enter a whole amount.' });
  });

  it('uses the currency digits', () => {
    expect(parseMoneyInput('1000', 'JPY')).toBe(1000);
    expect(centsToInput(1000, 'JPY')).toBe('1000');
    expect(centsToInput(1250, 'USD')).toBe('12.50');
    expect(centsToInput(125000, 'USD')).toBe('1250.00');
  });
});
