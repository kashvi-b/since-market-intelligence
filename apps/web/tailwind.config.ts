import type { Config } from 'tailwindcss'

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Near-monochrome by design. Ink is the page, paper is the ground,
        // and `signal` is the single accent — reserved exclusively for
        // attention, never for decoration.
        ink: {
          DEFAULT: '#12100E', muted: '#57534E', faint: '#8A837C', hairline: '#E7E3DE',
        },
        paper: { DEFAULT: '#FBFAF8', raised: '#FFFFFF', sunk: '#F4F2EF' },
        signal: { DEFAULT: '#B4401F', soft: '#F2E4DE' },
        positive: '#2F6B4F',
      },
      fontFamily: {
        // System stacks only: the app must build and run with no network.
        serif: ['Iowan Old Style', 'Palatino Linotype', 'Palatino', 'Georgia', 'serif'],
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Inter', 'Helvetica Neue', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Menlo', 'monospace'],
      },
      letterSpacing: { tightest: '-0.035em' },
    },
  },
  plugins: [],
} satisfies Config
