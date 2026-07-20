export interface PlatformBadge {
  label: string;
  class: string;
}

const KNOWN: Record<string, string> = {
  javascript: 'JavaScript',
  python: 'Python',
};

export function platformBadge(
  platform: string | null | undefined,
): PlatformBadge | null {
  if (!platform) return null;
  return {
    label: KNOWN[platform] ?? platform,
    class: 'bg-surface-2 text-text',
  };
}
