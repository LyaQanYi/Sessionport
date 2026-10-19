/** @type {import('tailwindcss').Config} */
const withAlpha = (variable) => 'hsl(var(' + variable + ') / <alpha-value>)';

module.exports = {
  darkMode: ['class'],
  content: ['src/renderer/index.html', 'src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: withAlpha('--background'),
        foreground: withAlpha('--foreground'),
        card: { DEFAULT: withAlpha('--card'), foreground: withAlpha('--card-foreground') },
        popover: { DEFAULT: withAlpha('--popover'), foreground: withAlpha('--popover-foreground') },
        primary: { DEFAULT: withAlpha('--primary'), foreground: withAlpha('--primary-foreground') },
        secondary: { DEFAULT: withAlpha('--secondary'), foreground: withAlpha('--secondary-foreground') },
        muted: { DEFAULT: withAlpha('--muted'), foreground: withAlpha('--muted-foreground') },
        accent: { DEFAULT: withAlpha('--accent'), foreground: withAlpha('--accent-foreground') },
        destructive: { DEFAULT: withAlpha('--destructive'), foreground: withAlpha('--destructive-foreground') },
        border: withAlpha('--border'),
        input: withAlpha('--input'),
        ring: withAlpha('--ring'),
        surface: withAlpha('--surface'),
        subtle: withAlpha('--subtle'),
        selected: withAlpha('--selected'),
        fg: {
          1: withAlpha('--fg-1'),
          2: withAlpha('--fg-2'),
          3: withAlpha('--fg-3'),
        },
        'border-strong': withAlpha('--border-strong'),
        success: withAlpha('--success'),
        warning: withAlpha('--warning'),
        sidebar: {
          DEFAULT: withAlpha('--sidebar'),
          foreground: withAlpha('--sidebar-foreground'),
          muted: withAlpha('--sidebar-muted-foreground'),
          border: withAlpha('--sidebar-border'),
          row: withAlpha('--sidebar-row-hover'),
          selected: withAlpha('--sidebar-row-selected'),
        },
      },
      borderRadius: {
        control: '6px',
        panel: '10px',
        dialog: '14px',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'sans-serif'],
        mono: ['SFMono-Regular', 'ui-monospace', 'Menlo', 'monospace'],
      },
      fontSize: {
        page: ['18px', { lineHeight: '26px', fontWeight: '600' }],
        title: ['16px', { lineHeight: '22px', fontWeight: '600' }],
        section: ['15px', { lineHeight: '22px', fontWeight: '600' }],
        body: ['13px', { lineHeight: '20px' }],
        caption: ['11px', { lineHeight: '16px' }],
        badge: ['11px', { lineHeight: '16px', fontWeight: '500' }],
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
