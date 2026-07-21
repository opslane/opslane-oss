import type { TestStatus } from './test-runner.js';

export interface ParsedJUnit {
  outcome: 'passed' | 'failed' | 'infra_error';
  tests: Map<string, TestStatus>;
  total: number;
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' } as Record<string, string>)[entity.toLowerCase()] ?? match;
  });
}

function attr(source: string, name: string): string | null {
  const match = source.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`));
  return match ? decodeXml(match[1] ?? match[2] ?? '') : null;
}

/** Parse only pytest's bounded JUnit testcase subset. Never throws. */
export function parseJUnitXml(raw: string): ParsedJUnit {
  const tests = new Map<string, TestStatus>();
  try {
    const xml = raw.trim();
    if (!xml || !/<testsuites?\b/.test(xml) || !/<\/testsuites?>\s*$/.test(xml)) {
      return { outcome: 'infra_error', tests, total: 0 };
    }
    const allowedTags = new Set([
      'testsuites', 'testsuite', 'testcase', 'failure', 'error', 'skipped',
      'properties', 'property', 'system-out', 'system-err',
      // Common pytest plugin elements. Without these a repo using e.g.
      // pytest-rerunfailures downgrades every run to infra_error, so no fix
      // could ever be verified there.
      'rerunFailure', 'flakyFailure', 'flakyError', 'rerun',
    ]);
    for (const tag of xml.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)\b/g)) {
      if (!allowedTags.has(tag[1]!)) return { outcome: 'infra_error', tests: new Map(), total: 0 };
    }
    let sawError = false;
    let count = 0;
    const testcase = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
    const matchedCases = [...xml.matchAll(testcase)];
    const testcaseCount = [...xml.matchAll(/<testcase\b/g)].length;
    if (matchedCases.length !== testcaseCount) return { outcome: 'infra_error', tests: new Map(), total: 0 };
    for (const match of matchedCases) {
      const classname = attr(match[1]!, 'classname');
      const name = attr(match[1]!, 'name');
      if (classname === null || name === null) return { outcome: 'infra_error', tests: new Map(), total: 0 };
      const body = match[2] ?? '';
      if (/<error\b/.test(body)) {
        sawError = true;
        continue;
      }
      if (/<skipped\b/.test(body)) continue;
      const id = `${classname}::${name}`;
      const status: TestStatus = /<failure\b/.test(body) ? 'failed' : 'passed';
      if (tests.get(id) !== 'failed') tests.set(id, status);
      count++;
    }
    if (count === 0 || tests.size === 0 || sawError) {
      return { outcome: 'infra_error', tests, total: count };
    }
    return {
      outcome: [...tests.values()].some((status) => status === 'failed') ? 'failed' : 'passed',
      tests,
      total: count,
    };
  } catch {
    return { outcome: 'infra_error', tests: new Map(), total: 0 };
  }
}
