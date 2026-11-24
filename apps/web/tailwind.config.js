/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: 'var(--color-bg)',
          deep: 'var(--color-bg-deep)',
          panel: 'var(--color-panel)',
          panel2: 'var(--color-panel-2)',
          solid: 'var(--color-panel-solid)',
          border: 'var(--color-border)',
          borderStrong: 'var(--color-border-strong)',
        },
        brand: {
          DEFAULT: 'var(--color-primary)',
          light: 'var(--color-primary-light)',
          dark: 'var(--color-primary-dark)',
        },
        aurora: {
          violet: '#8b5cf6',
          fuchsia: '#d946ef',
          cyan: '#22d3ee',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 32px rgba(124, 58, 237, 0.35)',
        aurora: '0 8px 32px rgba(124, 58, 237, 0.35), 0 0 24px rgba(217, 70, 239, 0.18)',
        card: '0 1px 3px rgba(0, 0, 0, 0.4)',
        'card-hover': '0 12px 32px rgba(0, 0, 0, 0.45), 0 0 28px rgba(124, 58, 237, 0.22)',
      },
      borderRadius: {
        card: 'var(--radius-card)',
        control: 'var(--radius-control)',
      },
      keyframes: {
        'page-in': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'float-soft': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.6)', opacity: '0.9' },
          '100%': { transform: 'scale(1.9)', opacity: '0' },
        },
      },
      animation: {
        'page-in': 'page-in 0.35s ease-out both',
        'float-soft': 'float-soft 5s ease-in-out infinite',
        'pulse-ring': 'pulse-ring 1.6s ease-out infinite',
      },
    },
  },
  plugins: [],
}
