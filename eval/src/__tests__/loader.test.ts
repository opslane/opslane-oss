import { describe, it, expect } from 'vitest';
import { loadAllCases } from '../loader.js';
import path from 'node:path';

const CASES_DIR = path.resolve(import.meta.dirname, '../../cases');

describe('loadAllCases', () => {
  it('loads all 23 eval cases', async () => {
    const cases = await loadAllCases(CASES_DIR);
    expect(cases).toHaveLength(23);
  });

  it('has 15 vue cases and 8 react cases', async () => {
    const cases = await loadAllCases(CASES_DIR);
    const vue = cases.filter(c => c.app === 'vue-app');
    const react = cases.filter(c => c.app === 'react-app');
    expect(vue).toHaveLength(15);
    expect(react).toHaveLength(8);
  });

  it('has 20 fixable cases and 3 needs_human cases', async () => {
    const cases = await loadAllCases(CASES_DIR);
    const fixable = cases.filter(c => c.expected.outcome === 'fix_pr');
    const needsHuman = cases.filter(c => c.expected.outcome === 'needs_human');
    expect(fixable).toHaveLength(20);
    expect(needsHuman).toHaveLength(3);
  });

  it('fixable cases have bug_patch, needs_human cases have null', async () => {
    const cases = await loadAllCases(CASES_DIR);
    for (const c of cases) {
      if (c.expected.outcome === 'fix_pr') {
        expect(c.bug_patch, `${c.id} should have bug_patch`).toBeTruthy();
      } else {
        expect(c.bug_patch, `${c.id} should have null bug_patch`).toBeNull();
      }
    }
  });

  it('every case has required fields', async () => {
    const cases = await loadAllCases(CASES_DIR);
    for (const c of cases) {
      expect(c.id).toBeTruthy();
      expect(c.app).toBeTruthy();
      expect(c.error_event.error.type).toBeTruthy();
      expect(c.error_event.error.message).toBeTruthy();
      expect(c.metadata.category).toBeTruthy();
      expect(c.metadata.difficulty).toBeTruthy();
      expect(c.metadata.framework).toBeTruthy();
      expect(c.grading).toBeDefined();
    }
  });
});
