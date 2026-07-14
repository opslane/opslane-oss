import { describe, it, expect } from 'vitest';
import { buildReplayEvidenceFromRecording } from '../replay-evidence.js';

// Minimal rrweb-shaped recording: a page with a heading + button, the user clicks
// the button, then a crash. Mirrors the real captured shape (node.type 2=Element,
// 3=Text; incremental source 2 = MouseInteraction, data.type 2 = Click).
function sampleRecording() {
  const node = {
    type: 0, id: 1, childNodes: [
      { type: 2, tagName: 'html', id: 2, attributes: {}, childNodes: [
        { type: 2, tagName: 'body', id: 3, attributes: {}, childNodes: [
          { type: 2, tagName: 'div', id: 4, attributes: { id: 'app' }, childNodes: [
            { type: 2, tagName: 'h1', id: 5, attributes: {}, childNodes: [{ type: 3, id: 6, textContent: 'Eval Demo' }] },
            { type: 2, tagName: 'button', id: 16, attributes: { 'data-testid': 'crash-btn' }, childNodes: [{ type: 3, id: 17, textContent: 'Load user profile' }] },
          ] },
        ] },
      ] },
    ],
  };
  return {
    meta: { crash_timestamp: 1000, page_url: 'http://localhost:5173/users/2' },
    events: [
      { type: 4, data: { href: 'http://localhost:5173/users/2' }, timestamp: 800 },
      { type: 2, data: { node }, timestamp: 810 },
      { type: 3, data: { source: 2, type: 2, id: 16 }, timestamp: 900 }, // click button
      { type: 3, data: { source: 0, adds: [{ parentId: 4, node: { type: 2, tagName: 'div', id: 20, attributes: { class: 'user-card' }, childNodes: [{ type: 3, id: 21, textContent: 'No profile' }] } }] }, timestamp: 990 },
    ],
  };
}

describe('buildReplayEvidenceFromRecording', () => {
  it('returns null for an empty recording', () => {
    expect(buildReplayEvidenceFromRecording({ events: [] }, null)).toBeNull();
  });

  it('extracts route, visible UI, last user action, and crash DOM from rrweb events', () => {
    const ev = buildReplayEvidenceFromRecording(sampleRecording(), {
      errorType: 'TypeError',
      errorMessage: "Cannot read properties of null (reading 'profile')",
    });
    expect(ev).not.toBeNull();
    // route + visible UI
    expect(ev!.whatUserSaw).toContain('localhost:5173/users/2');
    expect(ev!.whatUserSaw).toContain('Load user profile');
    // the click is reconstructed and attributed to the button
    expect(ev!.failureMoment.toLowerCase()).toContain('clicked');
    expect(ev!.failureMoment).toContain('Load user profile');
    // crash DOM addition (the user-card that rendered) shows up
    expect(ev!.failureMoment).toContain('No profile');
    // error surfaced in uxImpact
    expect(ev!.uxImpact).toContain('TypeError');
    expect(ev!.confidence).toBe('high');
  });

  it('ignores events after crash_timestamp', () => {
    const rec = sampleRecording();
    rec.events.push({ type: 3, data: { source: 2, type: 2, id: 16 }, timestamp: 5000 } as never);
    const ev = buildReplayEvidenceFromRecording(rec, null);
    // only the one pre-crash click is counted
    expect(ev!.failureMoment).toContain('1 user action');
  });
});
