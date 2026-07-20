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
  // Outlined, not filled: the Error kind badge is bg-surface-2, so an
  // identical fill would make the two adjacent pills read as one.
  return {
    label: KNOWN[platform] ?? platform,
    class: 'border border-border text-text',
  };
}
