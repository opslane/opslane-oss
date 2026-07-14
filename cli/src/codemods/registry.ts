import type { Codemod } from './types.js';
import { reactViteCodemod } from './react-vite.js';
import { nextjsCodemod } from './nextjs.js';
import { vueViteCodemod } from './vue-vite.js';
import { nuxtCodemod } from './nuxt.js';

const codemods = new Map<string, Codemod>([
  ['react-vite', reactViteCodemod],
  ['nextjs', nextjsCodemod],
  ['vue-vite', vueViteCodemod],
  ['nuxt', nuxtCodemod],
]);

/**
 * Look up the deterministic codemod for a given framework.
 * Returns null if no codemod exists (triggers AI fallback).
 */
export function getCodemod(framework: string): Codemod | null {
  return codemods.get(framework) ?? null;
}
