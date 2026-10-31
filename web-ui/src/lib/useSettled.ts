import { useEffect, useState } from 'react';

const SEARCH_DELAY_MS = 300;

/** A search box's text, trimmed and settled once the person stops typing for 300 ms. */
export function useSettled(value: string) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [value]);
  return settled;
}
