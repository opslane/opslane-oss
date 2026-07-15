import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _rehydrateFromStorage,
  ensureSessionID,
  getSessionId,
  nextChunkSeq,
  peekChunkSeq,
  resetSessionId,
  rotateSessionIfIdle,
  setSessionUser,
  touchSession,
} from '../session';

describe('session', () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetSessionId();
    vi.useRealTimers();
  });

  afterEach(() => vi.useRealTimers());

  it('mints an id and persists it to sessionStorage', () => {
    const id = ensureSessionID();
    expect(id).toBeTruthy();
    expect(ensureSessionID()).toBe(id);
    expect(sessionStorage.getItem('opslane_session')).toContain(id);
  });

  it('restores the id and seq counter across a reload', () => {
    const id = ensureSessionID();
    expect(nextChunkSeq()).toBe(0);
    expect(nextChunkSeq()).toBe(1);
    expect(nextChunkSeq()).toBe(2);
    resetSessionId();
    _rehydrateFromStorage();
    expect(ensureSessionID()).toBe(id);
    expect(nextChunkSeq()).toBe(3);
  });

  it('peekChunkSeq does not consume', () => {
    ensureSessionID();
    expect(peekChunkSeq()).toBe(0);
    expect(peekChunkSeq()).toBe(0);
    expect(nextChunkSeq()).toBe(0);
    expect(peekChunkSeq()).toBe(1);
  });

  it('rotates after 30 minutes idle', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T12:00:00Z'));
    const first = ensureSessionID();
    vi.setSystemTime(new Date('2026-07-14T12:31:00Z'));
    expect(ensureSessionID()).toBe(first);
    const rotation = rotateSessionIfIdle();
    expect(rotation?.previous).toEqual({ id: first, nextSeq: 0 });
    expect(rotation?.newSessionID).not.toBe(first);
    expect(peekChunkSeq()).toBe(0);
  });

  it('does not rotate while active', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T12:00:00Z'));
    const first = ensureSessionID();
    for (let i = 1; i <= 3; i += 1) {
      const minutes = i * 20;
      vi.setSystemTime(new Date(`2026-07-14T${String(12 + Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00Z`));
      touchSession();
      expect(ensureSessionID()).toBe(first);
    }
  });

  it('rotates on identity change', () => {
    const anon = ensureSessionID();
    expect(setSessionUser('alice')).toBe(true);
    const alice = getSessionId();
    expect(alice).not.toBe(anon);
    expect(setSessionUser('alice')).toBe(false);
    expect(getSessionId()).toBe(alice);
    expect(setSessionUser('bob')).toBe(true);
    expect(getSessionId()).not.toBe(alice);
    expect(setSessionUser(null)).toBe(true);
  });

  it('resets the seq counter on rotation', () => {
    ensureSessionID();
    nextChunkSeq();
    nextChunkSeq();
    setSessionUser('alice');
    expect(peekChunkSeq()).toBe(0);
  });

  it('falls back to memory when sessionStorage throws', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() { throw new Error('SecurityError'); },
    });
    try {
      resetSessionId();
      const id = ensureSessionID();
      expect(ensureSessionID()).toBe(id);
      expect(nextChunkSeq()).toBe(0);
      expect(nextChunkSeq()).toBe(1);
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });

  it('recovers from corrupted stored state', () => {
    sessionStorage.setItem('opslane_session', 'not json');
    resetSessionId();
    _rehydrateFromStorage();
    expect(ensureSessionID()).toBeTruthy();
    expect(peekChunkSeq()).toBe(0);
  });
});
