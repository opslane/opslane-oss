import { describe, it, expect } from 'vitest';
import { parseStackFrames, resolveFrame } from '../source-map.js';

describe('parseStackFrames', () => {
  it('parses standard V8 stack trace with function names', () => {
    const stack = `TypeError: Cannot read property 'map' of null
    at Foo.render (http://localhost:3000/assets/main-abc123.js:42:15)
    at processChild (http://localhost:3000/assets/vendor-def456.js:100:8)`;

    const frames = parseStackFrames(stack);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({
      file: 'http://localhost:3000/assets/main-abc123.js',
      line: 42,
      column: 15,
    });
    expect(frames[1]).toEqual({
      file: 'http://localhost:3000/assets/vendor-def456.js',
      line: 100,
      column: 8,
    });
  });

  it('parses anonymous function frames', () => {
    const stack = `Error: oops
    at http://example.com/bundle.js:10:5
    at Array.forEach (<anonymous>)`;

    const frames = parseStackFrames(stack);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      file: 'http://example.com/bundle.js',
      line: 10,
      column: 5,
    });
  });

  it('returns empty array for non-stack-trace input', () => {
    expect(parseStackFrames('no stack here')).toEqual([]);
    expect(parseStackFrames('')).toEqual([]);
  });

  it('parses file paths without URLs', () => {
    const stack = `Error: fail
    at doSomething (/app/dist/index.js:55:12)`;

    const frames = parseStackFrames(stack);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      file: '/app/dist/index.js',
      line: 55,
      column: 12,
    });
  });

  it('handles multiple frames', () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      `    at fn${i} (file${i}.js:${i + 1}:${i})`
    ).join('\n');
    const stack = `Error: test\n${lines}`;

    const frames = parseStackFrames(stack);
    expect(frames).toHaveLength(10);
    expect(frames[9]).toEqual({ file: 'file9.js', line: 10, column: 9 });
  });
});

/**
 * Minimal source map for testing. Maps:
 *   generated line 1, column 0 -> original "src/app.ts" line 5, column 4
 *
 * The mappings string "AAIA" encodes a single segment:
 *   - generated column 0 (A = 0)
 *   - source index 0 (A = 0)
 *   - original line 4 (I = 4, 0-based -> line 5 1-based)
 *   - original column 4 (A shifts by... actually we need correct VLQ)
 *
 * Using a well-known minimal source map format.
 */
function makeSourceMap(opts?: {
  sources?: string[];
  sourcesContent?: (string | null)[];
  mappings?: string;
}): string {
  return JSON.stringify({
    version: 3,
    sources: opts?.sources ?? ['src/app.ts'],
    sourcesContent: opts?.sourcesContent ?? [
      'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8',
    ],
    // "AAAA" maps gen line 1, col 0 -> source 0, orig line 1 (0-indexed: 0), orig col 0
    mappings: opts?.mappings ?? 'AAAA',
  });
}

describe('resolveFrame', () => {
  it('resolves a frame to original position', () => {
    const sourceMap = makeSourceMap();
    const frame = { file: 'dist/app.js', line: 1, column: 0 };

    const result = resolveFrame(frame, sourceMap);
    expect(result).not.toBeNull();
    expect(result!.originalFile).toBe('src/app.ts');
    expect(result!.originalLine).toBe(1);
    expect(result!.originalColumn).toBe(0);
  });

  it('includes source snippet when sourcesContent is available', () => {
    const content = 'import React from "react";\nfunction App() {\n  return <div>Hello</div>;\n}\nexport default App;';
    const sourceMap = makeSourceMap({
      sourcesContent: [content],
    });
    const frame = { file: 'dist/app.js', line: 1, column: 0 };

    const result = resolveFrame(frame, sourceMap);
    expect(result).not.toBeNull();
    expect(result!.sourceSnippet).not.toBeNull();
    // Snippet should contain lines around line 1
    expect(result!.sourceSnippet).toContain('import React');
  });

  it('returns null for invalid JSON', () => {
    const result = resolveFrame(
      { file: 'app.js', line: 1, column: 0 },
      'not valid json',
    );
    expect(result).toBeNull();
  });

  it('returns null for invalid source map structure', () => {
    const result = resolveFrame(
      { file: 'app.js', line: 1, column: 0 },
      JSON.stringify({ version: 3 }),
    );
    // TraceMap may not throw but will return no position
    // Either null (thrown) or null (no source found) is acceptable
    expect(result).toBeNull();
  });

  it('returns null when position maps to no source', () => {
    // Empty mappings means no positions are mapped
    const sourceMap = makeSourceMap({ mappings: '' });
    const result = resolveFrame(
      { file: 'app.js', line: 10, column: 0 },
      sourceMap,
    );
    expect(result).toBeNull();
  });

  it('handles source map without sourcesContent (snippet is null)', () => {
    const sourceMap = JSON.stringify({
      version: 3,
      sources: ['src/app.ts'],
      mappings: 'AAAA',
    });
    const frame = { file: 'dist/app.js', line: 1, column: 0 };

    const result = resolveFrame(frame, sourceMap);
    expect(result).not.toBeNull();
    expect(result!.sourceSnippet).toBeNull();
  });
});
