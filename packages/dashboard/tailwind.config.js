// Token colors are CSS custom properties, so Tailwind can't parse them to
// apply opacity modifiers (`bg-teal/10`). Emitting color-mix() keeps the
// tokens theme-switchable while making `/N` modifiers work. Only numeric
// modifiers get color-mix(); plain utilities receive opacityValue as
// `var(--tw-bg-opacity)` and must stay `var()` so base colors keep working
// on browsers without color-mix() support (pre-2023).
const token = (name) => ({ opacityValue }) => {
  const alpha = Number.parseFloat(opacityValue)
  return Number.isNaN(alpha) || alpha === 1
    ? `var(${name})`
    : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: token('--color-background'),
        surface: token('--color-surface'),
        'surface-2': token('--color-surface-2'),
        border: token('--color-border'),
        'border-subtle': token('--color-border-subtle'),
        text: token('--color-text'),
        'text-muted': token('--color-text-muted'),
        'text-faint': token('--color-text-faint'),
        teal: token('--color-teal'),
        indigo: token('--color-indigo'),
        green: token('--color-green'),
        amber: token('--color-amber'),
        red: token('--color-red'),
        purple: token('--color-purple'),
        'on-accent': token('--color-on-accent'),
      },
      boxShadow: {
        card: 'var(--shadow-card)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      borderColor: {
        DEFAULT: 'var(--color-border)',
      },
    },
  },
  plugins: [],
}
