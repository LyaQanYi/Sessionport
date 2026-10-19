import type { ReactNode } from 'react';

export function cn(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'ghost' | 'danger';
  className?: string;
  title?: string;
}): ReactNode {
  const { children, onClick, disabled, variant = 'primary', className, title } = props;
  const base = 'inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed';
  const styles =
    variant === 'primary'
      ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:opacity-90'
      : variant === 'danger'
        ? 'bg-[hsl(var(--destructive))] text-white hover:opacity-90'
        : 'border border-[hsl(var(--border))] bg-transparent hover:bg-[hsl(var(--muted))]';
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled} className={cn(base, styles, className)}>
      {children}
    </button>
  );
}

export function Badge(props: { children: ReactNode; tone?: 'default' | 'info' | 'warn' | 'error' }): ReactNode {
  const { children, tone = 'default' } = props;
  const toneClass =
    tone === 'info'
      ? 'bg-sky-500/15 text-sky-300 border-sky-500/30'
      : tone === 'warn'
        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
        : tone === 'error'
          ? 'bg-red-500/15 text-red-300 border-red-500/30'
          : 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] border-[hsl(var(--border))]';
  return <span className={cn('inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium', toneClass)}>{children}</span>;
}

export function Card(props: { children: ReactNode; className?: string }): ReactNode {
  return <div className={cn('rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))]', props.className)}>{props.children}</div>;
}

export function EmptyState(props: { title: string; hint?: string }): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center">
      <div className="text-sm text-[hsl(var(--foreground))]">{props.title}</div>
      {props.hint ? <div className="max-w-md text-xs text-[hsl(var(--muted-foreground))]">{props.hint}</div> : null}
    </div>
  );
}

export function Spinner(): ReactNode {
  return <div className="h-4 w-4 animate-spin rounded-full border-2 border-[hsl(var(--border))] border-t-[hsl(var(--primary))]" />;
}
