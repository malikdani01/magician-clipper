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
          border: 'var(--color-border)',
        },
        brand: {
          DEFAULT: 'var(--color-primary)',
          light: 'var(--color-primary-light)',
          dark: 'var(--color-primary-dark)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 32px rgba(124, 58, 237, 0.35)',
        card: '0 1px 3px rgba(0, 0, 0, 0.4)',
      },
    },
  },
  plugins: [],
}
