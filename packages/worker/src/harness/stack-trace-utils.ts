const DEV_PATH_TAIL_START =
  '(?:(?:packages|apps|src|app|pages|components|lib|server|client|shared|cli|eval|test-fixtures|test-e2e|tests|__tests__|dist|build|assets)/|[A-Za-z0-9_.-]+\\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|py|go|rs))';

const HOME_ABS_PREFIX = new RegExp(
  `(?:[A-Za-z]:)?/(?:Users|home)/[^:\\s)\\]}>'"\\x60]*?/(?=${DEV_PATH_TAIL_START})`,
  'g',
);

const HOME_PREFIX_AFTER_URL_STRIP = new RegExp(
  `\\b(?:Users|home)/[^:\\s)\\]}>'"\\x60]*?/(?=${DEV_PATH_TAIL_START})`,
  'g',
);

/**
 * Scrub local dev origins and host-specific home-directory prefixes from text
 * before it is shown to reviewers. This intentionally targets localhost,
 * Vite's @fs prefix, and home-directory paths instead of stripping every
 * absolute path; production file:line:column frames should remain useful.
 */
export function scrubDevPaths(text: string): string {
  return text
    .replace(/\\/g, '/')
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/g, '')
    .replace(/\/@fs\//g, '/')
    .replace(/\b@fs\//g, '')
    .replace(HOME_ABS_PREFIX, '')
    .replace(HOME_PREFIX_AFTER_URL_STRIP, '');
}

/**
 * Extract source file paths from a stack trace string.
 * Handles V8/Node, Firefox/Safari, and Vite dev server formats.
 * Returns deduplicated relative paths, excluding node_modules.
 */
export function extractStackTraceFiles(stackTrace: string): string[] {
  const paths = new Set<string>();
  // Per-line patterns to avoid cross-line false positives
  const patterns: RegExp[] = [
    /\(([^)]+?):\d+:\d+\)/g,               // V8: (src/App.vue:19:17)
    /at\s+([^\s(:]+):\d+/g,                // V8 bare: at src/App.vue:19
    /[@]([^\s@]+?):\d+:\d+/g,              // Firefox/Safari: func@http://localhost:5175/src/App.vue:19:17
  ];

  for (const line of stackTrace.split('\n')) {
    // Skip entire line if it references node_modules
    if (line.includes('node_modules')) continue;

    for (const pattern of patterns) {
      // Reset lastIndex since we reuse the regex across lines
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        let filePath = match[1];
        // Strip URL origin (http://localhost:5175/)
        filePath = filePath.replace(/^https?:\/\/[^/]+\//, '');
        // Strip Vite @fs/ prefix
        filePath = filePath.replace(/^@fs\//, '');
        // Check node_modules after URL stripping (e.g. http://localhost/node_modules/...)
        if (filePath.includes('node_modules')) continue;
        // Only keep source file extensions. Include ESM/CJS variants (.mjs/.cjs/
        // .mts/.cts) — modern bundlers emit .mjs, and missing them would make
        // hasNoAppFrames() falsely classify a real app frame as stackless.
        if (!filePath.match(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|py|go|rs)$/)) continue;
        // Normalize to relative path
        const relative = filePath.replace(/^\//, '');
        // Skip absolute system paths (after URL/prefix stripping)
        if (relative.includes(':\\')) continue;
        // Skip paths that are clearly not project source (e.g. stripped @fs paths)
        if (relative.startsWith('Users/') || relative.includes('/Users/')) continue;
        if (relative.startsWith('home/') || relative.includes('/home/')) continue;
        paths.add(relative);
      }
    }
  }
  return [...paths];
}

/**
 * True when a stack trace contains no application source frames — i.e. it is
 * empty, or only references anonymous/eval/browser-internal or node_modules
 * frames. These are inherently unfixable by the agent (cross-origin
 * "Script error.", non-Error promise rejections), so callers can short-circuit
 * to needs_human before cloning the repo or spending an LLM/sandbox.
 *
 * Minified app-bundle frames (e.g. assets/index-abc123.js) DO count as app
 * frames — they may be source-mappable, so let the normal flow try and give up.
 */
export function hasNoAppFrames(stackTrace: string): boolean {
  return extractStackTraceFiles(stackTrace).length === 0;
}
