import type { SocialProviderId } from '../types/api';

export interface SocialButton {
  id: SocialProviderId;
  label: string;
  href: string;
}

const LABELS: Record<SocialProviderId, string> = {
  google: 'Continue with Google',
  github: 'Continue with GitHub',
};

export function socialProviderButtons(providers: SocialProviderId[]): SocialButton[] {
  return providers
    .filter((id): id is SocialProviderId => Object.prototype.hasOwnProperty.call(LABELS, id))
    .map((id) => ({ id, label: LABELS[id], href: `/auth/login?provider=${id}` }));
}
