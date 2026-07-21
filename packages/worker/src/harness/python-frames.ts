export interface PythonFrame {
  path: string;
  function: string;
}

const FRAME_RE = /^\s*File "([^"]+)", line \d+, in (.+)$/gm;
/**
 * Deployment roots, matched whole in a single pass so nested roots like
 * `/usr/src/app/` and `/home/deploy/app/` still reduce to the same relative
 * path as a bare `/app/`. Stripping iteratively instead would also eat a real
 * leading package directory, turning `/app/app/main.py` into `main.py`.
 */
const DEPLOY_PREFIX_RE = /^\/?(?:usr\/src\/|home\/[^/]+\/)?(?:app|srv|opt)\/|^\/?home\/[^/]+\//;
const LIB_PATH_RE = /(?:site-packages|dist-packages)\/|\/\.?venv\/|\.tox\/|lib\/python\d+(?:\.\d+)?\//;
const CHAIN_MARKERS = [
  '\nDuring handling of the above exception, another exception occurred:\n',
  '\nThe above exception was the direct cause of the following exception:\n',
];

/** `<string>`, `<frozen importlib._bootstrap>`, `<stdin>` — never repository files. */
const PSEUDO_PATH_RE = /^<.*>$/;

function collectFrames(segment: string): PythonFrame[] {
  const frames: PythonFrame[] = [];
  for (const match of segment.matchAll(FRAME_RE)) {
    const raw = match[1]!;
    if (LIB_PATH_RE.test(raw) || PSEUDO_PATH_RE.test(raw)) continue;
    // Strip the deployment root exactly once. Repeating it would eat a real
    // leading package directory — `/app/app/main.py` must stay `app/main.py`,
    // not collapse to `main.py` and resolve to the wrong file.
    frames.push({ path: raw.replace(DEPLOY_PREFIX_RE, ''), function: match[2]!.trim() });
  }
  return frames;
}

/**
 * @param limit Frames to keep. Defaults to 5 to match the grouping fingerprint
 *   contract in packages/ingestion. Callers that filter afterwards (resolving
 *   against tracked files) should pass a larger value, or unresolvable frames
 *   at the top of the stack starve the real one.
 */
export function parsePythonFrames(stack: string, limit = 5): PythonFrame[] {
  let segment = stack;
  for (const marker of CHAIN_MARKERS) {
    const index = segment.lastIndexOf(marker);
    if (index >= 0) segment = segment.slice(index + marker.length);
  }

  // An exception *message* can quote a chain marker (apps that log a formatted
  // traceback and re-raise). Splitting on it would yield zero frames and route
  // a real bug to the non-retriable `unfixable_no_app_frames` terminal state.
  let oldestFirst = collectFrames(segment);
  if (oldestFirst.length === 0 && segment !== stack) oldestFirst = collectFrames(stack);

  const seen = new Set<string>();
  const newestFirst: PythonFrame[] = [];
  for (const frame of oldestFirst.reverse()) {
    const identity = `${frame.path}:${frame.function}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    newestFirst.push(frame);
    if (newestFirst.length === limit) break;
  }
  return newestFirst;
}

/**
 * Match a traceback path to a tracked repository file by longest path suffix.
 *
 * Deployment roots vary (`/app`, `/code`, `/home/deploy/myapp`, bare relative
 * paths), so exact equality drops real frames whenever the runtime layout does
 * not equal the repository layout. Suffixes are compared on segment boundaries
 * and the longest match wins, so `app/cart.py` is preferred over `cart.py`.
 */
function matchTrackedFile(path: string, trackedFiles: Set<string>): string | null {
  if (trackedFiles.has(path)) return path;
  const segments = path.split('/').filter(Boolean);
  for (let i = 1; i < segments.length; i++) {
    const candidate = segments.slice(i).join('/');
    if (trackedFiles.has(candidate)) return candidate;
  }
  return null;
}

export function resolveFrames(frames: PythonFrame[], trackedFiles: Set<string>): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const frame of frames) {
    const match = matchTrackedFile(frame.path, trackedFiles);
    if (match === null || seen.has(match)) continue;
    seen.add(match);
    resolved.push(match);
  }
  return resolved;
}
