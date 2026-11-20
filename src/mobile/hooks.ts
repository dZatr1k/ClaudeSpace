import { useEffect, useState } from 'react';

/** the current time, refreshed every `ms` (countdowns, «думает 2 мин») */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}
