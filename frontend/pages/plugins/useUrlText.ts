import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A text box whose value also lives in the URL. Typing shows up at once and is
 * written to the URL; the URL is only copied back into the box when it changed
 * for some other reason (Back, a link, a Clear button).
 *
 * Why not just derive the box from the URL: router updates can land a beat
 * late, so the echo of an earlier keystroke can arrive after you typed more.
 * Copying that echo back would rewind the box and eat characters. We remember
 * what we wrote and ignore echoes of those values.
 */
export function useUrlText(urlValue: string, writeUrl: (value: string) => void): [string, (value: string) => void] {
  const [value, setValue] = useState(urlValue);
  // Values written to the URL that have not come back around yet, oldest first.
  const pending = useRef<string[]>([]);

  useEffect(() => {
    const at = pending.current.indexOf(urlValue);
    if (at >= 0) {
      pending.current.splice(0, at + 1);
      return;
    }
    pending.current = [];
    setValue(urlValue);
  }, [urlValue]);

  const set = useCallback(
    (next: string) => {
      pending.current.push(next);
      setValue(next);
      writeUrl(next);
    },
    [writeUrl],
  );

  return [value, set];
}
