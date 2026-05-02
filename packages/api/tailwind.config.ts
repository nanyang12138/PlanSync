import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Legacy aliases (kept so existing components don't break mid-migration)
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          soft: 'hsl(var(--primary-soft))',
          'soft-fg': 'hsl(var(--primary-soft-fg))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },

        // Semantic surfaces
        surface: {
          1: 'hsl(var(--surface-1))',
          2: 'hsl(var(--surface-2))',
          3: 'hsl(var(--surface-3))',
        },

        // Semantic foreground levels
        fg: {
          DEFAULT: 'hsl(var(--fg))',
          muted: 'hsl(var(--fg-muted))',
          subtle: 'hsl(var(--fg-subtle))',
        },

        // Semantic intent palette (each role = one hue)
        success: {
          DEFAULT: 'hsl(var(--success))',
          soft: 'hsl(var(--success-soft))',
          'soft-fg': 'hsl(var(--success-soft-fg))',
        },
        danger: {
          DEFAULT: 'hsl(var(--danger))',
          soft: 'hsl(var(--danger-soft))',
          'soft-fg': 'hsl(var(--danger-soft-fg))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          soft: 'hsl(var(--warning-soft))',
          'soft-fg': 'hsl(var(--warning-soft-fg))',
        },
        drift: {
          DEFAULT: 'hsl(var(--drift))',
          soft: 'hsl(var(--drift-soft))',
          'soft-fg': 'hsl(var(--drift-soft-fg))',
        },
        agent: {
          DEFAULT: 'hsl(var(--agent))',
          soft: 'hsl(var(--agent-soft))',
          'soft-fg': 'hsl(var(--agent-soft-fg))',
        },
        info: {
          DEFAULT: 'hsl(var(--info))',
          soft: 'hsl(var(--info-soft))',
          'soft-fg': 'hsl(var(--info-soft-fg))',
        },
      },
      borderColor: {
        subtle: 'hsl(var(--border-subtle))',
        strong: 'hsl(var(--border-strong))',
      },
      backgroundColor: {
        'surface-1': 'hsl(var(--surface-1))',
        'surface-2': 'hsl(var(--surface-2))',
        'surface-3': 'hsl(var(--surface-3))',
      },
      textColor: {
        'fg-muted': 'hsl(var(--fg-muted))',
        'fg-subtle': 'hsl(var(--fg-subtle))',
      },
      ringColor: {
        primary: 'hsl(var(--ring-primary))',
        danger: 'hsl(var(--ring-danger))',
        drift: 'hsl(var(--ring-drift))',
        success: 'hsl(var(--ring-success))',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xl: 'calc(var(--radius) + 4px)',
      },
      // Two-value spacing scale for component padding (panel inner / table cell)
      padding: {
        card: '1.25rem',
        cell: '0.5rem',
      },
      spacing: {
        card: '1.25rem',
        cell: '0.5rem',
      },
    },
  },
  plugins: [],
};

export default config;
