import type { ErrorEventPayload, Breadcrumb } from '@opslane/shared';

const TOKEN_HASH = /(?:access_token|id_token|refresh_token|token|code)=/i;

/** Strip query string + userinfo; blank token-bearing hashes, keep route hashes. */
export function scrubUrl(raw: string): string {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    u.search = '';
    u.username = '';
    u.password = '';
    if (u.hash && TOKEN_HASH.test(u.hash)) u.hash = '';
    return u.toString();
  } catch {
    // Non-parseable (custom scheme, relative): drop everything after ? or #.
    return raw.split(/[?#]/)[0];
  }
}

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// Matches `key <sep> value` where the value is either quoted (allowing spaces, e.g.
// JSON `"password":"hunter2"` or `password: "two words"`) or an unquoted run. The
// optional quotes around the key + separator let it catch JSON-serialized objects,
// which is the most common way a secret reaches a console breadcrumb.
const SECRET_KV =
  /\b(password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|auth|session|cookie)\b(["']?\s*[:=]\s*)(?:(["'])(.*?)\3|([^\s,&"'}]+))/gi;

const URL_IN_TEXT = /https?:\/\/[^\s'"]+/gi;

/** Redact common secret shapes from free text (console args, breadcrumb messages). */
export function scrubText(text: string): string {
  if (!text) return text;
  return text
    .replace(JWT, '[redacted-jwt]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(SECRET_KV, (_m, key, sep, quote) =>
      quote ? `${key}${sep}${quote}[redacted]${quote}` : `${key}${sep}[redacted]`
    );
}

/** Strip query strings/userinfo from any http(s) URLs embedded in free text. */
function scrubUrlsInText(text: string): string {
  if (!text) return text;
  return text.replace(URL_IN_TEXT, (u) => scrubUrl(u));
}

function scrubBreadcrumb(b: Breadcrumb): Breadcrumb {
  // URL-strip first (kills query PII like email/ssn that no denylist covers), then
  // redact secret shapes. Covers fetch/xhr messages (`GET <url>`) and console args.
  const out: Breadcrumb = { ...b, message: scrubText(scrubUrlsInText(b.message)) };
  if (b.data) {
    const data: Record<string, unknown> = { ...b.data };
    if (typeof data.url === 'string') data.url = scrubUrl(data.url);
    out.data = data;
  }
  return out;
}

/** Return a scrubbed shallow copy of the event (defense-in-depth, runs before beforeSend). */
export function scrubEvent(event: ErrorEventPayload): ErrorEventPayload {
  // `context`/`breadcrumbs` can be absent at runtime — flushEvents() itself guards
  // `if (!event.context)` for late-bound user context. Mirror that here, or scrubEvent
  // throws → enqueueEvent's catch silently drops the event.
  const context = event.context
    ? { ...event.context, url: event.context.url ? scrubUrl(event.context.url) : event.context.url }
    : event.context;
  // The thrown error's message/stack are app-controlled free text and routinely carry
  // interpolated secrets. Redact secret shapes, but do NOT URL-strip the stack — that
  // would mangle frame URLs the server uses for source-map symbolication.
  const error = event.error
    ? { ...event.error, message: scrubText(event.error.message), stack: scrubText(event.error.stack) }
    : event.error;
  return {
    ...event,
    error,
    context,
    breadcrumbs: Array.isArray(event.breadcrumbs) ? event.breadcrumbs.map(scrubBreadcrumb) : event.breadcrumbs,
  };
}
