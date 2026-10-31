import { useEffect, useRef, useState } from 'react';

const SEARCH_DELAY_MS = 300;

/**
 * A search box whose settled text lives in the URL. `value` is the text in the URL; `onSettle` gets
 * the trimmed text once the person stops typing for 300 ms. When the URL changes another way (Back),
 * the box shows the URL's text again.
 */
export function useSearchText(value: string, onSettle: (text: string) => void) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  if (value !== seen) {
    setSeen(value);
    if (value !== text.trim()) setText(value);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  const onChange = (next: string) => {
    setText(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (next.trim() !== value) onSettle(next.trim());
    }, SEARCH_DELAY_MS);
  };
  return [text, onChange] as const;
}
