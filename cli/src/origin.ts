/**
 * Canonical origin (design R3-7): lowercase scheme + host, default ports
 * stripped, no path/query/trailing slash. Used as the key prefix for
 * credential and PKCE-token storage so hosted and self-hosted servers never
 * share state, and to decide when a self-hosted `endpoint` must be emitted.
 *
 * `URL.origin` already lowercases the scheme+host and drops default ports
 * (80 for http, 443 for https) and the path; we lowercase again to normalize
 * hosts that arrive with mixed case.
 */
export function canonicalOrigin(input: string): string {
  return new URL(input).origin.toLowerCase();
}
