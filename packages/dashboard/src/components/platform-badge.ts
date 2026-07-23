import { knownPlatformRecipe, type KnownPlatform } from '../status-recipes';

export interface PlatformBadge {
  label: string;
}

function isKnownPlatform(platform: string): platform is KnownPlatform {
  return platform === 'javascript' || platform === 'python';
}

export function platformBadge(
  platform: string | null | undefined,
): PlatformBadge | null {
  if (!platform) return null;
  return { label: isKnownPlatform(platform) ? knownPlatformRecipe(platform).label : platform };
}
