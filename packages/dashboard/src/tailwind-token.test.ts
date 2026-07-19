import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain-JS Tailwind config has no type declarations
import config from '../tailwind.config.js';

type TokenColor = (opts: { opacityValue?: string }) => string;

const colors = (
  config as {
    theme: { extend: { colors: Record<string, TokenColor> } };
  }
).theme.extend.colors;

describe('tailwind token colors', () => {
  it('emits plain var() when no opacity modifier is given', () => {
    expect(colors['green']!({ opacityValue: undefined })).toBe('var(--color-green)');
  });

  it('emits plain var() for the non-numeric opacity variable Tailwind passes to core utilities', () => {
    // Plain `bg-green` (no /N) receives `var(--tw-bg-opacity)`; it must not
    // become color-mix() or base colors break on browsers without color-mix.
    expect(colors['green']!({ opacityValue: 'var(--tw-bg-opacity)' })).toBe('var(--color-green)');
  });

  it('emits plain var() for a fully opaque modifier', () => {
    expect(colors['green']!({ opacityValue: '1' })).toBe('var(--color-green)');
  });

  it('emits color-mix() for numeric opacity modifiers like bg-green/10', () => {
    expect(colors['green']!({ opacityValue: '0.1' })).toBe(
      'color-mix(in srgb, var(--color-green) calc(0.1 * 100%), transparent)',
    );
  });
});
