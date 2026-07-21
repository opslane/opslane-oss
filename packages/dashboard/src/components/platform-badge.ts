export interface PlatformBadge {
  label: string;
  class: string;
}

import { knownPlatformRecipe, type KnownPlatform } from '../status-recipes';

function isKnownPlatform(platform: string): platform is KnownPlatform {
  return platform === 'javascript' || platform === 'python';
}

export function platformBadge(
  platform: string | null | undefined,
): PlatformBadge | null {
  if (!platform) return null;
  // Outlined, not filled: the Error kind badge uses the neutral StatusLabel tone, so an
  // identical fill would make the two adjacent pills read as one.
  return {
    label: isKnownPlatform(platform) ? knownPlatformRecipe(platform).label : platform,
    class: 'border border-border-strong bg-surface text-muted',
  };
}
