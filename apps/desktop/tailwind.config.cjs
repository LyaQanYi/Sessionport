/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: ['src/renderer/index.html', 'src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card: { DEFAULT: 'var(--card)', foreground: 'var(--card-foreground)' },
        popover: { DEFAULT: 'var(--popover)', foreground: 'var(--popover-foreground)' },
        primary: { DEFAULT: 'var(--primary)', foreground: 'var(--primary-foreground)' },
        secondary: { DEFAULT: 'var(--secondary)', foreground: 'var(--secondary-foreground)' },
        muted: { DEFAULT: 'var(--muted)', foreground: 'var(--muted-foreground)' },
        accent: { DEFAULT: 'var(--accent)', foreground: 'var(--accent-foreground)' },
        destructive: { DEFAULT: 'var(--destructive)', foreground: 'var(--destructive-foreground)' },
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        sidebar: {
          DEFAULT: 'var(--sidebar)',
          foreground: 'var(--sidebar-foreground)',
          muted: 'var(--sidebar-muted-foreground)',
          border: 'var(--sidebar-border)',
          row: 'var(--sidebar-row-hover)',
          selected: 'var(--sidebar-row-selected)',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Inter', 'sans-serif'],
        mono: ['SFMono-Regular', 'ui-monospace', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['11px', '16px'],
        '3xs': ['10px', '14px'],
      },
      spacing: {
        topbar: '52px',
        sidebar: '248px',
      },
      maxWidth: {
        chat: '46rem',
      },
    },
  },
  plugins: [],
};
