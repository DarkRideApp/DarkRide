import { useState, useEffect } from 'react';

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function toMs(d: string | number): number {
  return typeof d === 'number' ? d * 1000 : new Date(d).getTime();
}

export function ElapsedTimer({ since }: { since: string | number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);
  const elapsed = Date.now() - toMs(since);
  return <>{formatDuration(elapsed)}</>;
}
