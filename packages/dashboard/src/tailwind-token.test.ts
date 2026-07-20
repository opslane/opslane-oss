import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const tokens = readFileSync(new URL('./styles/tokens.css', import.meta.url), 'utf8');
const theme = readFileSync(new URL('./styles/theme.css', import.meta.url), 'utf8');
const base = readFileSync(new URL('./styles/base.css', import.meta.url), 'utf8');

const semanticRoles = [
  'background', 'surface', 'surface-subtle', 'border', 'border-strong', 'text', 'muted', 'faint',
  'accent', 'accent-hover', 'on-accent', 'danger', 'danger-subtle', 'success', 'success-subtle',
  'warning', 'warning-subtle', 'progress', 'progress-subtle', 'insight', 'insight-subtle', 'evidence',
  'evidence-surface', 'evidence-border', 'evidence-text', 'evidence-muted',
];

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)?.map((channel) => Number.parseInt(channel, 16) / 255) ?? [];
  const [red = 0, green = 0, blue = 0] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('Tailwind 4 semantic foundation', () => {
  it('maps every required semantic role into the CSS-first theme', () => {
    for (const role of semanticRoles) {
      expect(theme).toContain(`--color-${role}: var(--ds-${role})`);
      expect(tokens).toContain(`--ds-${role}:`);
    }
  });

  it('declares each light semantic token once', () => {
    const root = tokens.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    const declarations = [...root.matchAll(/--ds-([\w-]+)\s*:/g)].map((match) => match[1]);
    expect(new Set(declarations).size).toBe(declarations.length);
  });

  it('keeps normal and faint text AA-legible on paper', () => {
    expect(contrast('#24211d', '#fbfaf7')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#625d55', '#fbfaf7')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#746e65', '#fbfaf7')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', '#b74420')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#f2f0ea', '#15191c')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#b8c0c3', '#15191c')).toBeGreaterThanOrEqual(4.5);
  });

  it('provides visible focus and a global reduced-motion fallback', () => {
    expect(base).toContain(':focus-visible');
    expect(base).toContain('outline: 2px solid var(--ds-focus)');
    expect(base).toContain('@media (prefers-reduced-motion: reduce)');
    expect(base).toContain('animation-duration: 0.01ms !important');
  });
});
