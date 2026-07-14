const lastSeen = new Map<string, number>();
const MAX_KEYS = 200;

function firstFrame(stack: string): string {
  const line = stack.split('\n').find((l) => /\bat\b|:\d+:\d+/.test(l));
  return (line ?? '').trim();
}

/** Returns true if this error should be DROPPED (an identical one was seen within windowMs). */
export function shouldThrottle(
  type: string, message: string, stack: string, windowMs: number, now: number,
): boolean {
  if (windowMs <= 0) return false;
  const key = `${type}::${message}::${firstFrame(stack)}`;
  const prev = lastSeen.get(key);
  if (prev !== undefined && now - prev < windowMs) return true;
  lastSeen.set(key, now);
  if (lastSeen.size > MAX_KEYS) {
    // Drop the oldest insertion (Map preserves insertion order).
    const oldest = lastSeen.keys().next().value as string | undefined;
    if (oldest !== undefined) lastSeen.delete(oldest);
  }
  return false;
}

export function _resetThrottle(): void {
  lastSeen.clear();
}
