import { describe, it, expect } from 'vitest';
import { extractStackTraceFiles, hasNoAppFrames, scrubDevPaths } from '../harness/stack-trace-utils.js';

describe('extractStackTraceFiles', () => {
  it('extracts files from V8-style stack traces', () => {
    const stack = `TypeError: Cannot read properties of null
    at Proxy.render (src/components/UserCard.vue:9:30)
    at renderComponentRoot (node_modules/@vue/runtime-core/dist/runtime-core.esm-bundler.js:4499:16)`;
    const files = extractStackTraceFiles(stack);
    expect(files).toEqual(['src/components/UserCard.vue']);
  });

  it('extracts files from Firefox/Safari-style stack traces', () => {
    const stack = `verifyAccess@http://localhost:5175/src/App.vue:19:17
checkPermissions@http://localhost:5175/src/App.vue:16:16`;
    const files = extractStackTraceFiles(stack);
    expect(files).toEqual(['src/App.vue']);
  });

  it('strips Vite @fs/ prefix', () => {
    const stack = `at console.log (http://localhost:5175/@fs/Users/user/project/packages/sdk/dist/index.js:5470:5)`;
    const files = extractStackTraceFiles(stack);
    expect(files).toEqual([]);  // absolute path after @fs stripping — filtered out
  });

  it('skips node_modules paths', () => {
    const stack = `at renderComponentRoot (node_modules/@vue/runtime-core/dist/runtime-core.esm-bundler.js:4499:16)
    at Proxy.render (src/App.vue:10:5)`;
    const files = extractStackTraceFiles(stack);
    expect(files).toEqual(['src/App.vue']);
  });

  it('deduplicates repeated files', () => {
    const stack = `at verifyAccess (src/App.vue:19:17)
    at checkPermissions (src/App.vue:16:16)
    at verifyAccess (src/App.vue:19:17)`;
    const files = extractStackTraceFiles(stack);
    expect(files).toEqual(['src/App.vue']);
  });

  it('returns empty array for empty stack', () => {
    expect(extractStackTraceFiles('')).toEqual([]);
  });

  it('handles bare path format (no parens, no function name)', () => {
    const stack = `at src/utils/helpers.ts:42:10`;
    const files = extractStackTraceFiles(stack);
    expect(files).toEqual(['src/utils/helpers.ts']);
  });

  it('handles bare URL frames from anonymous top-level throws (no parens)', () => {
    const stack = `Error: Watcher validation failed: counter 3 exceeded max limit of 2
    at http://localhost:5174/src/components/WatcherBug.vue:10:15
    at callWithErrorHandling (http://localhost:5174/node_modules/.vite/deps/vue.js?v=9a83a401:2377:19)`;
    const files = extractStackTraceFiles(stack);
    expect(files).toEqual(['src/components/WatcherBug.vue']);
  });
});

describe('hasNoAppFrames', () => {
  it('is true for an empty stack (cross-origin "Script error." / non-Error rejection)', () => {
    expect(hasNoAppFrames('')).toBe(true);
  });

  it('is true for a stack with only anonymous/eval/browser-internal frames', () => {
    const stack = `Error\n    at <anonymous>\n    at eval (eval at <anonymous>)`;
    expect(hasNoAppFrames(stack)).toBe(true);
  });

  it('is false when at least one application frame is present', () => {
    const stack = `TypeError: x\n    at Proxy.render (src/App.vue:9:30)`;
    expect(hasNoAppFrames(stack)).toBe(false);
  });

  it('is false for a minified app-bundle frame (let normal flow try, then give up after clone)', () => {
    const stack = `at a (https://app.example.com/assets/index-abc123.js:1:5000)`;
    expect(hasNoAppFrames(stack)).toBe(false);
  });

  it('is false for a production ESM (.mjs) / CJS (.cjs) bundle frame — must not falsely classify as stackless', () => {
    // Modern bundlers emit .mjs/.cjs; these are real, source-mappable app frames
    // and must NOT be parked as non-retriable needs_human.
    expect(hasNoAppFrames(`at a (https://app.example.com/assets/index-abc123.mjs:1:5000)`)).toBe(false);
    expect(hasNoAppFrames(`at b (https://app.example.com/assets/vendor-def456.cjs:2:10)`)).toBe(false);
  });
});

describe('scrubDevPaths', () => {
  it('removes localhost origins, Vite @fs, and home-directory prefixes', () => {
    const text = 'at render (http://localhost:5173/@fs/Users/abhi/project/src/App.vue:42:9)';
    expect(scrubDevPaths(text)).toBe('at render (src/App.vue:42:9)');
  });

  it('removes 127.0.0.1 origins while preserving route paths', () => {
    expect(scrubDevPaths('Page URL: http://127.0.0.1:5173/users/42')).toBe('Page URL: /users/42');
  });

  it('does not strip arbitrary absolute production paths', () => {
    const text = 'at render (/srv/app/releases/current/src/App.vue:42:9)';
    expect(scrubDevPaths(text)).toBe(text);
  });

  it('normalizes Windows home paths to repo-relative tails', () => {
    expect(scrubDevPaths('at render (C:\\Users\\abhi\\project\\src\\App.tsx:10:2)')).toBe(
      'at render (src/App.tsx:10:2)',
    );
  });

  it('keeps root-level source filenames after stripping home prefixes', () => {
    expect(scrubDevPaths('at boot (/Users/abhi/project/vite.config.ts:5:1)')).toBe(
      'at boot (vite.config.ts:5:1)',
    );
  });
});
