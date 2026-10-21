import clsx, { type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';
import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Copy, Loader2 } from 'lucide-react';

import { useT } from './i18n/I18nProvider.tsx';

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['page', 'title', 'section', 'body', 'caption', 'badge', '2xs', '3xs'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
type ButtonSize = 'sm' | 'default' | 'icon';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
  outline: 'border border-border bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
  ghost: 'bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-caption',
  default: 'h-8 gap-1.5 px-3 text-body',
  icon: 'h-7 w-7 justify-center',
};

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize },
): ReactNode {
  const { className, variant = 'default', size = 'default', type = 'button', ...rest } = props;
  return (
    <button
      type={type}
      className={cn(
        'inline-flex select-none items-center rounded-control font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        'disabled:pointer-events-none disabled:opacity-40',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...rest}
    />
  );
}

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive';

const BADGE_VARIANTS: Record<BadgeVariant, string> = {
  default: 'border-transparent bg-primary/10 text-fg-1',
  secondary: 'border-transparent bg-secondary text-fg-2',
  outline: 'border-border text-fg-2',
  success: 'border-transparent bg-success/12 text-success',
  warning: 'border-transparent bg-warning/12 text-warning',
  destructive: 'border-transparent bg-destructive/10 text-destructive',
};

export function Badge(props: { children: ReactNode; variant?: BadgeVariant; className?: string }): ReactNode {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-badge leading-none',
        BADGE_VARIANTS[props.variant ?? 'secondary'],
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}

export function Card(props: { children: ReactNode; className?: string }): ReactNode {
  return <div className={cn('rounded-panel border border-border bg-card text-card-foreground', props.className)}>{props.children}</div>;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  const { className, ...rest } = props;
  return (
    <input
      className={cn(
        'h-8 w-full rounded-control border border-input bg-background px-2.5 text-body text-fg-1',
        'placeholder:text-fg-3 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    />
  );
}

export function SearchField(props: { value: string; onChange: (value: string) => void; placeholder?: string; className?: string }): ReactNode {
  return (
    <div className={cn('relative', props.className)}>
      <svg className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <Input value={props.value} onChange={(event) => props.onChange(event.target.value)} placeholder={props.placeholder} className="pl-7" />
    </div>
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }): ReactNode {
  const { className, children, ...rest } = props;
  return (
    <select
      className={cn(
        'h-8 w-full appearance-none rounded-control border border-input bg-background px-2.5 text-body text-fg-1',
        'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function CheckboxRow(props: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }): ReactNode {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-caption text-fg-2">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
        className="h-3.5 w-3.5 rounded border-input accent-[hsl(var(--ring))]"
      />
      {props.children}
    </label>
  );
}

/** 分段控件（对应 cc-switch 的 SegmentedControl） */
export function SegmentedControl<T extends string>(props: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  className?: string;
}): ReactNode {
  return (
    <div className={cn('inline-flex items-center rounded-control border border-border bg-subtle p-0.5', props.className)}>
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => props.onChange(option.value)}
          className={cn(
            'h-6 rounded-[4px] px-2 text-caption transition-colors',
            props.value === option.value ? 'bg-card text-fg-1 shadow-sm' : 'text-fg-2 hover:text-fg-1',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** 设置页版式：分节标题 + 卡片 + 一行一项（cc-switch SettingsLayout） */
export function SettingsBlock(props: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <section className="space-y-2.5">
      <div className="flex min-h-7 items-center gap-2">
        <h2 className="text-section text-fg-1">{props.title}</h2>
        {props.description ? <span className="text-caption text-fg-3">{props.description}</span> : null}
        {props.actions ? <div className="ml-auto flex items-center gap-2">{props.actions}</div> : null}
      </div>
      {props.children}
    </section>
  );
}

export function SettingsCard(props: { children: ReactNode; className?: string }): ReactNode {
  return <div className={cn('divide-y divide-border overflow-hidden rounded-panel border border-border bg-card', props.className)}>{props.children}</div>;
}

export function SettingsRow(props: { label: ReactNode; description?: ReactNode; children?: ReactNode; className?: string }): ReactNode {
  return (
    <div className={cn('flex min-h-[44px] items-center gap-4 px-4 py-2.5', props.className)}>
      <div className="min-w-0">
        <div className="text-body text-fg-1">{props.label}</div>
        {props.description ? <div className="mt-0.5 text-caption text-fg-2">{props.description}</div> : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">{props.children}</div>
    </div>
  );
}

export function Separator(props: { className?: string }): ReactNode {
  return <div className={cn('h-px w-full bg-border', props.className)} />;
}

export function Kbd(props: { children: ReactNode }): ReactNode {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-3xs text-fg-2">
      {props.children}
    </kbd>
  );
}

export function Spinner(props: { className?: string }): ReactNode {
  return <Loader2 className={cn('h-4 w-4 animate-spin text-fg-2', props.className)} />;
}

export function EmptyState(props: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center">
      {props.icon ? <div className="text-fg-3">{props.icon}</div> : null}
      <div className="text-section text-fg-1">{props.title}</div>
      {props.hint ? <div className="max-w-sm text-caption leading-relaxed text-fg-2">{props.hint}</div> : null}
      {props.action}
    </div>
  );
}

/** 页面头：52px，左侧可选图标/返回，右侧操作（cc-switch AppPageHeader） */
export function Topbar(props: {
  leading?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}): ReactNode {
  return (
    <header className="flex h-topbar shrink-0 items-center gap-3 border-b border-border bg-background px-4">
      {props.leading}
      {props.icon ? <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center text-fg-1">{props.icon}</span> : null}
      <div className="min-w-0">
        <div className="truncate text-title text-fg-1">{props.title}</div>
        {props.subtitle ? <div className="truncate text-caption text-fg-2">{props.subtitle}</div> : null}
      </div>
      {props.children}
      <div className="ml-auto flex items-center gap-2">{props.actions}</div>
    </header>
  );
}

/** 行内悬停才出现的图标按钮（会话行的复制/打开等动作） */
export function RowAction(props: { label: string; onClick: () => void; children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      title={props.label}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      className="inline-flex h-6 w-6 items-center justify-center rounded-control text-fg-3 transition-colors hover:bg-accent hover:text-fg-1 focus-visible:opacity-100 group-hover:opacity-100"
    >
      {props.children}
    </button>
  );
}

export function CopyButton(props: { text: string; label?: string }): ReactNode {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(props.text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      <Copy className="h-3.5 w-3.5" />
      {copied ? t('common.copied') : (props.label ?? t('common.copy'))}
    </Button>
  );
}