import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let ticks = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    timer = setInterval(() => {
      ticks++;
      for (const notify of listeners) notify();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The current time in ms, re-read once a second. Every caller shares one timer, which runs only while one is mounted. */
export function useNow(): number {
  useSyncExternalStore(subscribe, () => ticks);
  return Date.now();
}
