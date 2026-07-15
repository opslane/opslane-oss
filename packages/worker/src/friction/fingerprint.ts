import { createHash } from 'node:crypto';

/** Strip query/hash; template numeric and UUID/hash-like path segments. */
export function normalizePageUrl(href: string): string {
  try {
    const url = new URL(href);
    const path = url.pathname
      .split('/')
      .map((segment) =>
        /^\d+$/.test(segment) || /^[0-9a-f-]{8,}$/i.test(segment) ? ':id' : segment,
      )
      .join('/');
    return `${url.origin}${path}`;
  } catch {
    return href.split(/[?#]/)[0] ?? href;
  }
}

export function frictionFingerprint(
  signalType: string,
  selector: string | null,
  pageUrl: string,
): string {
  return createHash('sha256')
    .update(`${signalType}|${selector ?? ''}|${pageUrl}`)
    .digest('hex')
    .slice(0, 32);
}
