let sessionID = '';

export function ensureSessionID(): string {
  if (sessionID) {
    return sessionID;
  }

  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      sessionID = crypto.randomUUID();
      return sessionID;
    }
  } catch {
    // noop
  }

  sessionID = `sess_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return sessionID;
}

export function getSessionId(): string {
  return sessionID;
}

export function resetSessionId(): void {
  sessionID = '';
}
