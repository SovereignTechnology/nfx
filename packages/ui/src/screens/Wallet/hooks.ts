/** Small hooks shared by the Wallet screen and its sheets. */
import { useEffect, useRef, useState, type RefObject } from 'react';

/** `true` while mounted; async callbacks check it before touching state. */
export function useAlive(): RefObject<boolean> {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

/**
 * The clock's current unix seconds, re-read once a second while `active` (expiry countdowns).
 * `clock` must be referentially stable (the screen passes a ref-backed callback).
 */
export function useNow(clock: () => number, active: boolean): number {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    if (!active) return;
    setNow(clock());
    const t = setInterval(() => {
      setNow(clock());
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, [active, clock]);
  return now;
}
