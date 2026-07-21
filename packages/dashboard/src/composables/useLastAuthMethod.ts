import type { SocialProviderId } from '../types/api';

export type LastAuthMethod = SocialProviderId | 'redirect' | 'password';

const STORAGE_KEY = 'opslane.last_auth_method';

// Exhaustive by construction: adding a SocialProviderId is a compile error here
// until it is listed, matching the icon map in SocialLoginButtons.vue. A plain
// string[] would compile fine and silently reject the new provider on read.
const VALID_METHODS: Record<LastAuthMethod, true> = {
  google: true,
  github: true,
  redirect: true,
  password: true,
};

function isLastAuthMethod(value: string | null): value is LastAuthMethod {
  return value !== null && Object.prototype.hasOwnProperty.call(VALID_METHODS, value);
}

/**
 * Which sign-in method the user last selected, or null if unknown.
 *
 * "Selected", not "succeeded": social and hosted-IdP logins redirect out of the
 * SPA, so their success is never observable here.
 */
export function readLastAuthMethod(): LastAuthMethod | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isLastAuthMethod(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeLastAuthMethod(method: LastAuthMethod): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, method);
  } catch {
    // Storage may be unavailable in private mode and embedded webviews. The
    // cosmetic badge must never prevent the login screen from rendering.
  }
}
