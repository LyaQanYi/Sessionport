import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
type ButtonSize = 'sm' | 'default' | 'icon';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground hover:opacity-90',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
  outline: 'border border-border bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
  ghost: 'bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
  destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-xs',
  default: 'h-8 gap-1.5 px-3 text-sm',
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
        'inline-flex select-none items-center rounded-md font-medium transition-colors',
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
  default: 'border-transparent bg-primary-soft text-primary',
  secondary: 'border-transparent bg-secondary text-muted-foreground',
  outline: 'border-border text-muted-foreground',
  success: 'border-transparent bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
  warning: 'border-transparent bg-amber-500/12 text-amber-600 dark:text-amber-400',
  destructive: 'border-transparent bg-destructive-soft text-destructive',
};

export function Badge(props: { children: ReactNode; variant?: BadgeVariant; className?: string }): ReactNode {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs font-medium leading-none',
        BADGE_VARIANTS[props.variant ?? 'secondary'],
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}

export function Card(props: { children: ReactNode; className?: string }): ReactNode {
  return <div className={cn('rounded-lg border border-border bg-card text-card-foreground', props.className)}>{props.children}</div>;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  const { className, ...rest } = props;
  return (
    <input
      className={cn(
        'h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground',
        'placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }): ReactNode {
  const { className, children, ...rest } = props;
  return (
    <select
      className={cn(
        'h-8 w-full appearance-none rounded-md border border-input bg-background px-2.5 text-sm text-foreground',
        'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
    <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
        className="h-3.5 w-3.5 rounded border-input accent-[var(--primary)]"
      />
      {props.children}
    </label>
  );
}

export function Separator(props: { className?: string }): ReactNode {
  return <div className={cn('h-px w-full bg-border', props.className)} />;
}

export function Kbd(props: { children: ReactNode }): ReactNode {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-3xs text-muted-foreground">
      {props.children}
    </kbd>
  );
}

export function Spinner(props: { className?: string }): ReactNode {
  return <Loader2 className={cn('h-4 w-4 animate-spin text-muted-foreground', props.className)} />;
}

export function EmptyState(props: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center">
      {props.icon ? <div className="text-muted-foreground opacity-60">{props.icon}</div> : null}
      <div className="text-sm font-medium">{props.title}</div>
      {props.hint ? <div className="max-w-sm text-xs leading-relaxed text-muted-foreground">{props.hint}</div> : null}
      {props.action}
    </div>
  );
}

/** 页面顶部栏：52px，和 t3 的 workspace topbar 对齐 */
export function Topbar(props: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }): ReactNode {
  return (
    <header className="flex h-topbar shrink-0 items-center gap-3 border-b border-border bg-background px-4 backdrop-blur">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{props.title}</div>
        {props.subtitle ? <div className="truncate text-2xs text-muted-foreground">{props.subtitle}</div> : null}
      </div>
      {props.children}
      <div className="ml-auto flex items-center gap-2">{props.actions}</div>
    </header>
  );
}
