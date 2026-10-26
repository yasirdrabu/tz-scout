const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Starts at a non-word character, is not an ISO date, and ends before a non-word character.
const PHONE = /(?<![\w])(?!\d{4}-\d{2}-\d{2})\+?\(?\d[\d\s().-]{5,}\d(?!\w)/g;

/** Replaces email addresses with `[email]` and phone numbers with `[phone]`, for showing stored text to people. */
export function redactPersonalText(text: string): string {
  return text.replace(EMAIL, '[email]').replace(PHONE, (m) => {
    const digits = m.replace(/\D/g, '').length;
    return digits >= 7 && digits <= 15 ? '[phone]' : m;
  });
}
