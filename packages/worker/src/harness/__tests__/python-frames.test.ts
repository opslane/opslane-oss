import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parsePythonFrames, resolveFrames } from '../python-frames.js';

interface TracebackCase {
  name: string;
  traceback: string;
  expectedFrames: Array<{ path: string; function: string }>;
}

const CASES = JSON.parse(await readFile(
  new URL('../../../../../test-fixtures/python-tracebacks/cases.json', import.meta.url),
  'utf8',
)) as TracebackCase[];

describe('parsePythonFrames', () => {
  it.each(CASES)('$name', ({ traceback, expectedFrames }) => {
    expect(parsePythonFrames(traceback)).toEqual(expectedFrames);
  });
});

function traceback(...paths: string[]): string {
  return ['Traceback (most recent call last):']
    .concat(paths.map((path) => `  File "${path}", line 1, in run\n    boom()`))
    .concat('ValueError: boom')
    .join('\n');
}

describe('parsePythonFrames deployment layouts', () => {
  it('strips the deployment root once, keeping a leading package named app/', () => {
    expect(parsePythonFrames(traceback('/app/app/main.py')))
      .toEqual([{ path: 'app/main.py', function: 'run' }]);
    expect(parsePythonFrames(traceback('/srv/app/app/cart.py')))
      .toEqual([{ path: 'app/app/cart.py', function: 'run' }]);
  });

  it('skips interpreter pseudo-frames so the pre-clone guard still fires', () => {
    expect(parsePythonFrames(traceback('<string>', '<frozen importlib._bootstrap>')))
      .toEqual([]);
  });

  it('falls back to the whole stack when a chain marker is quoted in the message', () => {
    const quoted = 'Traceback (most recent call last):\n'
      + '  File "/srv/svc/cart.py", line 9, in total\n    boom()\n'
      + 'RuntimeError: upstream said:\n'
      + 'During handling of the above exception, another exception occurred:\n';
    expect(parsePythonFrames(quoted)).toEqual([{ path: 'svc/cart.py', function: 'total' }]);
  });
});

describe('resolveFrames', () => {
  it('exact-matches, preserves frame order, and deduplicates paths', () => {
    const frames = [
      { path: 'b.py', function: 'b' },
      { path: 'missing.py', function: 'x' },
      { path: 'a.py', function: 'a' },
      { path: 'b.py', function: 'other' },
    ];
    expect(resolveFrames(frames, new Set(['a.py', 'b.py']))).toEqual(['b.py', 'a.py']);
  });

  it('prefers the longest tracked suffix over a shorter ambiguous one', () => {
    const frames = parsePythonFrames(traceback('/app/app/main.py'));
    expect(resolveFrames(frames, new Set(['app/main.py', 'main.py']))).toEqual(['app/main.py']);
  });

  it('resolves deployment roots the prefix list does not know about', () => {
    expect(resolveFrames(parsePythonFrames(traceback('/code/services/cart.py')), new Set(['services/cart.py'])))
      .toEqual(['services/cart.py']);
    expect(resolveFrames(parsePythonFrames(traceback('/home/deploy/myapp/services/cart.py')), new Set(['services/cart.py'])))
      .toEqual(['services/cart.py']);
  });

  it('does not match a suffix that breaks a path segment', () => {
    expect(resolveFrames([{ path: 'app/shopping_cart.py', function: 'run' }], new Set(['cart.py'])))
      .toEqual([]);
  });
});
