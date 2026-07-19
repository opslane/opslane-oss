import { describe, expect, it } from 'vitest';
import { socialProviderButtons } from './socialProviders';

describe('socialProviderButtons', () => {
  it('returns a button per configured provider, in order', () => {
    expect(socialProviderButtons(['github', 'google'])).toEqual([
      { id: 'github', label: 'Continue with GitHub', href: '/auth/login?provider=github' },
      { id: 'google', label: 'Continue with Google', href: '/auth/login?provider=google' },
    ]);
  });

  it('returns an empty array when nothing is configured', () => {
    expect(socialProviderButtons([])).toEqual([]);
  });

  it('ignores unknown ids defensively', () => {
    // @ts-expect-error exercising a malformed config value
    expect(socialProviderButtons(['myspace'])).toEqual([]);
  });
});
