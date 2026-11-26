import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Brain,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Globe,
  ListTodo,
  Pencil,
  Search,
  SquareTerminal,
  Terminal,
  Users,
  Wrench,
} from 'lucide-react';

import type { SessionEventRow } from '../api.ts';
import { Badge, cn } from '../ui.tsx';

export interface BulkToggleSignal {
  open: boolean;
  seq: number;
}

export type ReaderItem =
  | { kind: 'event'; event: SessionEventRow }
  | { kind: 'tool_pair'; id: string; call?: SessionEventRow; result?: SessionEventRow };

export type ToolCategory = 'shell' | 'read' | 'edit' | 'write' | 'search' | 'web' | 'agent' | 'todo' | 'other';

export interface ToolSummaryInfo {
  category: ToolCategory;
  summary: string;
  prettyInput: string;
}

/**
 * Compact one-click copy icon button with temporary copied state.
 * Stops propagation so it can safely live inside clickable headers or <summary>.
 */
export function InlineCopyButton(props: {
  text: string;
  label: string;
  copiedLabel: string;
  className?: string;
  showLabel?: boolean;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    void navigator.clipboard.writeText(props.text);
    setCopied(true);
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? props.copiedLabel : props.label}
      aria-label={copied ? props.copiedLabel : props.label}
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-control px-1.5 text-3xs transition-colors',
        'text-fg-3 hover:bg-accent hover:text-fg-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        copied && 'text-success opacity-100',
        props.className,
      )}
    >
      {copied ? <Check className="h-3 w-3 shrink-0 text-success" /> : <Copy className="h-3 w-3 shrink-0" />}
      {props.showLabel ? <span>{copied ? props.copiedLabel : props.label}</span> : null}
    </button>
  );
}

/** Highlight case-insensitive keyword occurrences in plain text nodes. */
export function highlightMatches(text: string, query?: string): ReactNode {
  const needle = query?.trim() ?? '';
  if (!needle || !text) return text;
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  while (cursor < text.length) {
    const matchIndex = lowerText.indexOf(lowerNeedle, cursor);
    if (matchIndex === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex));
    }
    parts.push(
      <mark key={key++} className="rounded-[2px] bg-ring/30 px-0.5 text-inherit">
        {text.slice(matchIndex, matchIndex + needle.length)}
      </mark>,
    );
    cursor = matchIndex + needle.length;
  }

  return parts.length === 1 ? parts[0] : parts;
}

function isSafeHttpsUrl(raw: string): boolean {
  if (!/^https:\/\/[^\s<>]+$/i.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

const ESCAPABLE_INLINE = new Set(['\\', '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!', '~']);

function findInlineCodeClose(text: string, start: number, tickLen: number): number {
  let i = start;
  while (i < text.length) {
    if (text[i] === '`') {
      let run = 1;
      while (i + run < text.length && text[i + run] === '`') run += 1;
      if (run === tickLen) return i;
      i += run;
      continue;
    }
    i += 1;
  }
  return -1;
}

function parseMarkdownLinkAt(text: string, start: number): { label: string; url: string; nextIndex: number } | null {
  if (text[start] !== '[') return null;
  let depth = 1;
  let i = start + 1;
  while (i < text.length && depth > 0) {
    const ch = text[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n') return null;
    if (ch === '[') depth += 1;
    else if (ch === ']') depth -= 1;
    i += 1;
  }
  if (depth !== 0 || text[i] !== '(') return null;

  const label = text.slice(start + 1, i - 1);
  let urlEnd = i + 1;
  let parenDepth = 1;
  while (urlEnd < text.length && parenDepth > 0) {
    const ch = text[urlEnd]!;
    if (ch === '\\') {
      urlEnd += 2;
      continue;
    }
    if (ch === '\n') return null;
    if (ch === '(') parenDepth += 1;
    else if (ch === ')') parenDepth -= 1;
    urlEnd += 1;
  }
  if (parenDepth !== 0) return null;

  const rawTarget = text.slice(i + 1, urlEnd - 1).trim();
  const spaceIdx = rawTarget.search(/\s/);
  const candidate = (spaceIdx === -1 ? rawTarget : rawTarget.slice(0, spaceIdx)).replace(/^<(.+)>$/, '$1');
  if (!isSafeHttpsUrl(candidate)) return null;
  return { label, url: candidate, nextIndex: urlEnd };
}

function consumeBareHttpsUrl(text: string, start: number): string | null {
  if (!text.startsWith('https://', start)) return null;
  if (start > 0 && /[a-zA-Z0-9]/.test(text[start - 1]!)) return null;
  let end = start;
  while (end < text.length && !/[\s<>'"`]/.test(text[end]!)) {
    end += 1;
  }
  let url = text.slice(start, end);
  while (url.length > 8) {
    const last = url[url.length - 1]!;
    if (last === '.' || last === ',' || last === ';' || last === ':' || last === '!' || last === '?') {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ')' || last === ']' || last === '}') {
      const openChar = last === ')' ? '(' : last === ']' ? '[' : '{';
      let opens = 0;
      let closes = 0;
      for (const c of url) {
        if (c === openChar) opens += 1;
        else if (c === last) closes += 1;
      }
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return isSafeHttpsUrl(url) ? url : null;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[a-zA-Z0-9_]/.test(ch);
}

function findClosingDelimiter(text: string, start: number, delim: string, requireWordBoundary: boolean): number {
  let i = start;
  while (i <= text.length - delim.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '`') {
      let tickLen = 1;
      while (i + tickLen < text.length && text[i + tickLen] === '`') tickLen += 1;
      const closeTick = findInlineCodeClose(text, i + tickLen, tickLen);
      if (closeTick !== -1) {
        i = closeTick + tickLen;
        continue;
      }
    }
    if (text.startsWith(delim, i)) {
      const prev = i > 0 ? text[i - 1] : undefined;
      const next = i + delim.length < text.length ? text[i + delim.length] : undefined;
      if (prev !== undefined && !/\s/.test(prev)) {
        if (!requireWordBoundary || !isWordChar(next)) {
          return i;
        }
      }
    }
    i += 1;
  }
  return -1;
}

function renderInline(text: string, searchQuery?: string, depth = 0): ReactNode[] {
  if (depth > 6) return [highlightMatches(text, searchQuery)];

  const nodes: ReactNode[] = [];
  let buffer = '';
  let key = 0;

  const flush = (): void => {
    if (!buffer) return;
    nodes.push(<Fragment key={key++}>{highlightMatches(buffer, searchQuery)}</Fragment>);
    buffer = '';
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '\\' && i + 1 < text.length && ESCAPABLE_INLINE.has(text[i + 1]!)) {
      buffer += text[i + 1]!;
      i += 2;
      continue;
    }

    if (ch === '`') {
      let tickLen = 1;
      while (i + tickLen < text.length && text[i + tickLen] === '`') tickLen += 1;
      const closeIdx = findInlineCodeClose(text, i + tickLen, tickLen);
      if (closeIdx !== -1) {
        flush();
        let code = text.slice(i + tickLen, closeIdx);
        if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim().length > 0) {
          code = code.slice(1, -1);
        }
        nodes.push(
          <code key={key++} className="rounded border border-border/60 bg-muted/80 px-1 py-px font-mono text-[12px] text-fg-1">
            {highlightMatches(code, searchQuery)}
          </code>,
        );
        i = closeIdx + tickLen;
        continue;
      }
      buffer += text.slice(i, i + tickLen);
      i += tickLen;
      continue;
    }

    if (ch === '[') {
      const link = parseMarkdownLinkAt(text, i);
      if (link) {
        flush();
        nodes.push(
          <a
            key={key++}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="break-words text-blue-600 underline decoration-blue-600/40 underline-offset-2 hover:decoration-blue-600 dark:text-sky-400 dark:decoration-sky-400/40 dark:hover:decoration-sky-400"
          >
            {renderInline(link.label, searchQuery, depth + 1)}
          </a>,
        );
        i = link.nextIndex;
        continue;
      }
    }

    if (ch === 'h' && text.startsWith('https://', i)) {
      const url = consumeBareHttpsUrl(text, i);
      if (url) {
        flush();
        nodes.push(
          <a
            key={key++}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-blue-600 underline decoration-blue-600/40 underline-offset-2 hover:decoration-blue-600 dark:text-sky-400 dark:decoration-sky-400/40 dark:hover:decoration-sky-400"
          >
            {highlightMatches(url, searchQuery)}
          </a>,
        );
        i += url.length;
        continue;
      }
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      const requireWordBoundary = ch === '_';
      const prev = i > 0 ? text[i - 1] : undefined;
      const canOpen = !requireWordBoundary || !isWordChar(prev);
      if (canOpen) {
        const candidates = ch === '~' ? ['~~'] : [ch + ch + ch, ch + ch, ch];
        let matched = false;
        for (const delim of candidates) {
          if (!text.startsWith(delim, i)) continue;
          const afterOpen = text[i + delim.length];
          if (afterOpen === undefined || /\s/.test(afterOpen)) continue;
          if (delim.length === 1 && afterOpen === ch) continue;
          const closeIdx = findClosingDelimiter(text, i + delim.length, delim, requireWordBoundary);
          if (closeIdx !== -1 && closeIdx > i + delim.length) {
            flush();
            const inner = text.slice(i + delim.length, closeIdx);
            const children = renderInline(inner, searchQuery, depth + 1);
            if (delim.length === 3) {
              nodes.push(
                <strong key={key++} className="font-semibold text-fg-1">
                  <em className="italic">{children}</em>
                </strong>,
              );
            } else if (delim === '**' || delim === '__') {
              nodes.push(
                <strong key={key++} className="font-semibold text-fg-1">
                  {children}
                </strong>,
              );
            } else if (delim === '~~') {
              nodes.push(
                <del key={key++} className="line-through opacity-75">
                  {children}
                </del>,
              );
            } else {
              nodes.push(
                <em key={key++} className="italic">
                  {children}
                </em>,
              );
            }
            i = closeIdx + delim.length;
            matched = true;
            break;
          }
        }
        if (matched) continue;
      }
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return nodes;
}

type MarkdownListItem = { text: string; children: MarkdownBlock[] };
type MarkdownBlock =
  | { type: 'code'; lang: string; code: string }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: 'hr' }
  | { type: 'blockquote'; blocks: MarkdownBlock[] }
  | { type: 'list'; ordered: boolean; start: number; items: MarkdownListItem[] }
  | { type: 'paragraph'; lines: string[] };

const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM_RE = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/;

function stripCommonIndent(lines: string[]): string[] {
  let minIndent = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = /^(\s*)/.exec(line);
    const len = match ? match[1]!.length : 0;
    if (len < minIndent) minIndent = len;
  }
  if (!Number.isFinite(minIndent) || minIndent === 0) return lines;
  return lines.map((line) => (line.length >= minIndent ? line.slice(minIndent) : line.trimStart()));
}

function isBlockStart(line: string): boolean {
  return FENCE_OPEN_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || LIST_ITEM_RE.test(line);
}

function parseMarkdownBlocks(source: string, depth = 0): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fenceMatch = FENCE_OPEN_RE.exec(line);
    if (fenceMatch) {
      const fence = fenceMatch[1]!;
      const fenceChar = fence[0]!;
      const fenceLen = fence.length;
      const lang = fenceMatch[2]!.trim().split(/\s+/)[0] ?? '';
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const candidate = lines[i]!;
        const closeMatch = new RegExp(`^\\s{0,3}${fenceChar === '`' ? '`' : '~'}{${fenceLen},}\\s*$`).exec(candidate);
        if (closeMatch) {
          i += 1;
          break;
        }
        codeLines.push(candidate);
        i += 1;
      }
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') });
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const level = headingMatch[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: 'heading', level, text: headingMatch[2]! });
      i += 1;
      continue;
    }

    if (depth < 8 && QUOTE_RE.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const qMatch = QUOTE_RE.exec(lines[i]!);
        if (!qMatch) break;
        quoteLines.push(qMatch[1]!);
        i += 1;
      }
      blocks.push({ type: 'blockquote', blocks: parseMarkdownBlocks(quoteLines.join('\n'), depth + 1) });
      continue;
    }

    const listMatch = LIST_ITEM_RE.exec(line);
    if (depth < 8 && listMatch && listMatch[1]!.length <= 3) {
      const baseIndent = listMatch[1]!.length;
      const ordered = listMatch[3] !== undefined;
      const start = ordered ? Math.max(1, Number(listMatch[3])) : 1;
      const items: MarkdownListItem[] = [];

      while (i < lines.length) {
        const itemLine = lines[i]!;
        const itemMatch = LIST_ITEM_RE.exec(itemLine);
        if (!itemMatch) break;
        const itemIndent = itemMatch[1]!.length;
        const itemOrdered = itemMatch[3] !== undefined;
        if (itemIndent > baseIndent + 1 || itemOrdered !== ordered) break;

        const itemText = itemMatch[4]!;
        const childLines: string[] = [];
        i += 1;

        while (i < lines.length) {
          const next = lines[i]!;
          if (!next.trim()) {
            // Keep blank line inside item only if followed by indented content
            const lookAhead = lines[i + 1];
            if (lookAhead !== undefined && /^\s{2,}\S/.test(lookAhead)) {
              childLines.push('');
              i += 1;
              continue;
            }
            break;
          }
          const nextListMatch = LIST_ITEM_RE.exec(next);
          if (nextListMatch) {
            const nextIndent = nextListMatch[1]!.length;
            if (nextIndent <= baseIndent + 1) break;
            childLines.push(next);
            i += 1;
            continue;
          }
          if (/^\s{2,}/.test(next)) {
            childLines.push(next);
            i += 1;
            continue;
          }
          if (isBlockStart(next)) break;
          // Lazy continuation line inside list item
          childLines.push(next);
          i += 1;
        }

        const children = childLines.length > 0 ? parseMarkdownBlocks(stripCommonIndent(childLines).join('\n'), depth + 1) : [];
        items.push({ text: itemText, children });
      }

      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }

    const paraLines: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i]!;
      if (!next.trim() || isBlockStart(next)) break;
      paraLines.push(next);
      i += 1;
    }
    blocks.push({ type: 'paragraph', lines: paraLines });
  }

  return blocks;
}

function CodeBlockView(props: {
  lang: string;
  code: string;
  fallbackLabel: string;
  copyLabel: string;
  copiedLabel: string;
  searchQuery?: string;
}): ReactNode {
  return (
    <div className="my-2 overflow-hidden rounded-control border border-border bg-subtle dark:bg-background/85">
      <div className="flex items-center justify-between border-b border-border/80 bg-muted/80 px-3 py-1 dark:bg-muted/50">
        <span className="font-mono text-3xs uppercase tracking-wider text-fg-2">
          {props.lang || props.fallbackLabel}
        </span>
        <InlineCopyButton
          text={props.code}
          label={props.copyLabel}
          copiedLabel={props.copiedLabel}
          showLabel
        />
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed text-fg-1">
        <code>{highlightMatches(props.code, props.searchQuery)}</code>
      </pre>
    </div>
  );
}

function renderMarkdownBlocks(
  blocks: MarkdownBlock[],
  opts: {
    searchQuery?: string;
    codeFallbackLabel: string;
    codeCopyLabel: string;
    copiedLabel: string;
  },
): ReactNode {
  return blocks.map((block, index) => {
    if (block.type === 'code') {
      return (
        <CodeBlockView
          key={index}
          lang={block.lang}
          code={block.code}
          fallbackLabel={opts.codeFallbackLabel}
          copyLabel={opts.codeCopyLabel}
          copiedLabel={opts.copiedLabel}
          searchQuery={opts.searchQuery}
        />
      );
    }

    if (block.type === 'hr') {
      return <hr key={index} className="my-2.5 border-t border-border" />;
    }

    if (block.type === 'heading') {
      const content = renderInline(block.text, opts.searchQuery);
      const cls =
        block.level === 1
          ? 'mt-3 mb-1.5 text-section font-semibold text-fg-1 first:mt-0'
          : block.level === 2
            ? 'mt-3 mb-1 text-[14px] font-semibold text-fg-1 first:mt-0'
            : block.level === 3
              ? 'mt-2.5 mb-1 text-body font-semibold text-fg-1 first:mt-0'
              : 'mt-2 mb-0.5 text-body font-medium text-fg-2 first:mt-0';
      if (block.level === 1) return <h1 key={index} className={cls}>{content}</h1>;
      if (block.level === 2) return <h2 key={index} className={cls}>{content}</h2>;
      if (block.level === 3) return <h3 key={index} className={cls}>{content}</h3>;
      if (block.level === 4) return <h4 key={index} className={cls}>{content}</h4>;
      if (block.level === 5) return <h5 key={index} className={cls}>{content}</h5>;
      return <h6 key={index} className={cls}>{content}</h6>;
    }

    if (block.type === 'blockquote') {
      return (
        <blockquote key={index} className="my-2 space-y-1.5 border-l-2 border-border-strong pl-3 text-fg-2">
          {renderMarkdownBlocks(block.blocks, opts)}
        </blockquote>
      );
    }

    if (block.type === 'list') {
      const listChildren = block.items.map((item, itemIndex) => (
        <li key={itemIndex} className="leading-relaxed">
          <span>{renderInline(item.text, opts.searchQuery)}</span>
          {item.children.length > 0 ? <div className="mt-1 space-y-1">{renderMarkdownBlocks(item.children, opts)}</div> : null}
        </li>
      ));
      if (block.ordered) {
        return (
          <ol key={index} start={block.start} className="my-1.5 list-decimal space-y-1 pl-5">
            {listChildren}
          </ol>
        );
      }
      return (
        <ul key={index} className="my-1.5 list-disc space-y-1 pl-5">
          {listChildren}
        </ul>
      );
    }

    return (
      <p key={index} className="leading-relaxed">
        {block.lines.map((line, lineIndex) => (
          <Fragment key={lineIndex}>
            {lineIndex > 0 ? <br /> : null}
            {renderInline(line, opts.searchQuery)}
          </Fragment>
        ))}
      </p>
    );
  });
}

/**
 * Lightweight zero-dependency Markdown renderer using pure React elements (never dangerouslySetInnerHTML).
 */
export function MarkdownText(props: {
  text: string;
  searchQuery?: string;
  className?: string;
  codeFallbackLabel?: string;
  codeCopyLabel?: string;
  copiedLabel?: string;
}): ReactNode {
  const blocks = useMemo(() => parseMarkdownBlocks(props.text), [props.text]);
  if (blocks.length === 0) return null;

  return (
    <div className={cn('space-y-2 break-words', props.className)}>
      {renderMarkdownBlocks(blocks, {
        searchQuery: props.searchQuery,
        codeFallbackLabel: props.codeFallbackLabel ?? 'text',
        codeCopyLabel: props.codeCopyLabel ?? 'Copy',
        copiedLabel: props.copiedLabel ?? 'Copied',
      })}
    </div>
  );
}

/**
 * Pair tool_call and tool_result events by non-empty toolCallId, preserving visual flow
 * and gracefully handling unpaired calls or orphan results.
 */
export function pairReaderEvents(events: readonly SessionEventRow[]): ReaderItem[] {
  const resultQueues = new Map<string, number[]>();
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]!;
    if (ev.kind === 'tool_result' && ev.toolCallId) {
      const queue = resultQueues.get(ev.toolCallId);
      if (queue) queue.push(i);
      else resultQueues.set(ev.toolCallId, [i]);
    }
  }

  const consumedResults = new Set<number>();
  const items: ReaderItem[] = [];

  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]!;
    if (ev.kind === 'tool_call') {
      let matchedIndex: number | undefined;
      if (ev.toolCallId) {
        const queue = resultQueues.get(ev.toolCallId);
        if (queue) {
          const forwardPos = queue.findIndex((idx) => idx > i && !consumedResults.has(idx));
          if (forwardPos !== -1) {
            matchedIndex = queue[forwardPos]!;
          } else {
            const anyPos = queue.findIndex((idx) => !consumedResults.has(idx));
            if (anyPos !== -1) matchedIndex = queue[anyPos]!;
          }
        }
      }
      if (matchedIndex !== undefined) {
        consumedResults.add(matchedIndex);
        items.push({ kind: 'tool_pair', id: ev.id, call: ev, result: events[matchedIndex]! });
      } else {
        items.push({ kind: 'tool_pair', id: ev.id, call: ev });
      }
      continue;
    }

    if (ev.kind === 'tool_result') {
      if (consumedResults.has(i)) continue;
      items.push({ kind: 'tool_pair', id: ev.id, result: ev });
      continue;
    }

    items.push({ kind: 'event', event: ev });
  }

  return items;
}

function normalizeToolKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clipOneLine(text: string, max = 110): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= max) return single;
  return single.slice(0, max - 1) + '…';
}

function formatDisplayPath(rawPath: string, cwd?: string): string {
  const trimmed = rawPath.trim();
  if (cwd) {
    const normalizedCwd = cwd.replace(/[/\\]+$/, '');
    if (trimmed === normalizedCwd) return '.';
    if (trimmed.startsWith(normalizedCwd + '/') || trimmed.startsWith(normalizedCwd + '\\')) {
      return trimmed.slice(normalizedCwd.length + 1);
    }
  }
  const homeCompact = trimmed.replace(/^\/Users\/[^/]+(?=\/)/, '~');
  if (homeCompact.length <= 96) return homeCompact;
  return homeCompact.slice(0, 30) + '…' + homeCompact.slice(-(96 - 31));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTruncatedJsonString(raw: string, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const re = new RegExp('"' + escapeRegExp(key) + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"');
    const match = re.exec(raw);
    if (match?.[1] !== undefined) {
      try {
        const parsed = JSON.parse('"' + match[1] + '"') as unknown;
        if (typeof parsed === 'string' && parsed.trim().length > 0) return parsed;
      } catch {
        if (match[1].trim().length > 0) return match[1];
      }
    }
  }
  return undefined;
}

function pickString(record: Record<string, unknown> | undefined, raw: string, keys: readonly string[]): string | undefined {
  if (record) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim().length > 0) return value;
      if (Array.isArray(value) && value.length > 0) {
        if (
          value.length === 3 &&
          typeof value[0] === 'string' &&
          ['bash', 'sh', 'zsh'].includes((value[0].split('/').pop() ?? '').toLowerCase()) &&
          (value[1] === '-c' || value[1] === '-lc') &&
          typeof value[2] === 'string'
        ) {
          return value[2];
        }
        return value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ');
      }
    }
    return undefined;
  }
  return extractTruncatedJsonString(raw, keys);
}

function pickNumber(record: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const val = record[key];
    if (typeof val === 'number' && Number.isFinite(val)) return val;
  }
  return undefined;
}

const SHELL_TOOLS = new Set([
  'bash',
  'shell',
  'shellcommand',
  'execcommand',
  'runterminalcommand',
  'runterminalcommandv2',
  'terminal',
  'runcommand',
  'localshell',
  'writestdin',
]);
const READ_TOOLS = new Set(['read', 'readfile', 'readfilev2', 'view', 'viewfile', 'openfile', 'viewfileoutline', 'viewcodeitem']);
const EDIT_TOOLS = new Set([
  'edit',
  'editfile',
  'editfilev2',
  'multiedit',
  'replacefilecontent',
  'multireplacefilecontent',
  'strreplace',
  'strreplaceeditor',
  'applypatch',
  'notebookedit',
]);
const WRITE_TOOLS = new Set(['write', 'writefile', 'writetofile', 'createfile', 'savefile', 'deletefile', 'removefile']);
const SEARCH_TOOLS = new Set([
  'grep',
  'ripgrep',
  'ripgrepsearch',
  'ripgreprawsearch',
  'grepsearch',
  'rg',
  'glob',
  'globfilesearch',
  'filesearch',
  'globsearch',
  'findbyname',
  'ls',
  'list',
  'listdir',
  'listdirv2',
  'listdirectory',
  'readdirectory',
]);
const WEB_TOOLS = new Set(['webfetch', 'websearch', 'fetch', 'readurlcontent', 'searchweb']);
const AGENT_TOOLS = new Set(['agent', 'task', 'taskv2', 'subagent', 'invokesubagent']);
const TODO_TOOLS = new Set(['todowrite', 'todoread', 'updateplan', 'todos', 'updatetodos', 'updatesteps']);

const PATH_KEYS = [
  'file_path',
  'filePath',
  'path',
  'target_file',
  'targetFile',
  'TargetFile',
  'absolute_path',
  'AbsolutePath',
  'Path',
  'File',
  'relativeWorkspacePath',
  'relative_workspace_path',
  'notebook_path',
];
const COMMAND_KEYS = ['command', 'cmd', 'script', 'CommandLine', 'chars'];
const PATTERN_KEYS = ['pattern', 'query', 'regex', 'glob_pattern', 'globPattern', 'Pattern', 'Query'];
const SEARCH_DIR_KEYS = ['path', 'directory', 'dir', 'target_directory', 'targetDirectory', 'SearchDirectory', 'SearchPath', 'DirectoryPath', 'Path'];

export function summarizeToolCall(toolName?: string, rawText?: string, cwd?: string): ToolSummaryInfo {
  const raw = rawText ?? '';
  let parsed: unknown;
  let prettyInput = raw;
  if (raw.trim().length > 0) {
    try {
      parsed = JSON.parse(raw) as unknown;
      prettyInput = JSON.stringify(parsed, null, 2) ?? raw;
    } catch {
      prettyInput = raw;
    }
  }
  const record = isRecord(parsed) ? parsed : undefined;
  const key = normalizeToolKey(toolName ?? '');

  if (SHELL_TOOLS.has(key)) {
    const cmd = pickString(record, raw, COMMAND_KEYS) ?? (typeof parsed === 'string' ? parsed : undefined);
    const desc = pickString(record, raw, ['description', 'toolSummary']);
    const text = cmd ? '$ ' + clipOneLine(cmd, 110) : desc ? clipOneLine(desc, 110) : '';
    return { category: 'shell', summary: text, prettyInput };
  }

  if (READ_TOOLS.has(key)) {
    const path = pickString(record, raw, PATH_KEYS);
    if (path) {
      const start = pickNumber(record, ['offset', 'start_line', 'startLine', 'StartLine']);
      const end = pickNumber(record, ['EndLine', 'endLine', 'end_line']);
      const limit = pickNumber(record, ['limit', 'line_count', 'lineCount']);
      const range =
        start !== undefined && end !== undefined
          ? ` (L${start}-${end})`
          : start !== undefined && limit !== undefined
            ? ` (L${start}+${limit})`
            : start !== undefined
              ? ` (L${start})`
              : '';
      return { category: 'read', summary: clipOneLine(formatDisplayPath(path, cwd) + range, 110), prettyInput };
    }
  }

  if (EDIT_TOOLS.has(key)) {
    if (key === 'applypatch') {
      const patch = pickString(record, raw, ['input', 'patch', 'patchText']) ?? (typeof parsed === 'string' ? parsed : raw);
      const patchMatch = /\*\*\* (?:Update|Add|Delete) File:\s*(.+)/.exec(patch);
      if (patchMatch?.[1]) return { category: 'edit', summary: clipOneLine(formatDisplayPath(patchMatch[1], cwd), 110), prettyInput };
    }
    const path = pickString(record, raw, PATH_KEYS);
    if (path) return { category: 'edit', summary: clipOneLine(formatDisplayPath(path, cwd), 110), prettyInput };
  }

  if (WRITE_TOOLS.has(key)) {
    const path = pickString(record, raw, PATH_KEYS);
    if (path) return { category: 'write', summary: clipOneLine(formatDisplayPath(path, cwd), 110), prettyInput };
  }

  if (SEARCH_TOOLS.has(key)) {
    const pattern = pickString(record, raw, PATTERN_KEYS);
    const dir = pickString(record, raw, SEARCH_DIR_KEYS);
    const shortDir = dir ? formatDisplayPath(dir, cwd) : undefined;
    if (pattern && shortDir) return { category: 'search', summary: clipOneLine(`/${pattern}/ in ${shortDir}`, 110), prettyInput };
    if (pattern) return { category: 'search', summary: clipOneLine(`/${pattern}/`, 110), prettyInput };
    if (shortDir) return { category: 'search', summary: clipOneLine(shortDir, 110), prettyInput };
  }

  if (WEB_TOOLS.has(key)) {
    const target = pickString(record, raw, ['url', 'Url', 'query', 'Query']);
    if (target) return { category: 'web', summary: clipOneLine(target, 110), prettyInput };
  }

  if (AGENT_TOOLS.has(key)) {
    const desc = pickString(record, raw, ['description', 'Name', 'name', 'subagent_type', 'prompt', 'Prompt']);
    if (desc) return { category: 'agent', summary: clipOneLine(desc, 110), prettyInput };
  }

  if (TODO_TOOLS.has(key)) {
    const list = record ? (record.todos ?? record.items ?? record.plan ?? record.steps) : undefined;
    if (Array.isArray(list)) {
      return { category: 'todo', summary: `${list.length} items`, prettyInput };
    }
  }

  const generic =
    pickString(record, raw, ['focus', 'description', 'toolSummary', ...COMMAND_KEYS, ...PATH_KEYS, ...PATTERN_KEYS, 'url', 'Url']) ??
    (record ? Object.values(record).find((v): v is string => typeof v === 'string' && v.trim().length > 0) : undefined);

  const fallback = generic ?? (raw && raw.trim() !== '{}' ? raw : '');
  const category: ToolCategory = SHELL_TOOLS.has(key)
    ? 'shell'
    : READ_TOOLS.has(key)
      ? 'read'
      : EDIT_TOOLS.has(key)
        ? 'edit'
        : WRITE_TOOLS.has(key)
          ? 'write'
          : SEARCH_TOOLS.has(key)
            ? 'search'
            : WEB_TOOLS.has(key)
              ? 'web'
              : AGENT_TOOLS.has(key)
                ? 'agent'
                : TODO_TOOLS.has(key)
                  ? 'todo'
                  : 'other';
  return { category, summary: fallback ? clipOneLine(fallback, 110) : '', prettyInput };
}

function toolIconFor(category: ToolCategory, hasCall: boolean): ReactNode {
  if (!hasCall) return <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-fg-3" />;
  switch (category) {
    case 'shell':
      return <Terminal className="h-3.5 w-3.5 shrink-0 text-fg-3" />;
    case 'read':
    case 'write':
      return <FileText className="h-3.5 w-3.5 shrink-0 text-fg-3" />;
    case 'edit':
      return <Pencil className="h-3.5 w-3.5 shrink-0 text-fg-3" />;
    case 'search':
      return <Search className="h-3.5 w-3.5 shrink-0 text-fg-3" />;
    case 'web':
      return <Globe className="h-3.5 w-3.5 shrink-0 text-fg-3" />;
    case 'agent':
      return <Users className="h-3.5 w-3.5 shrink-0 text-fg-3" />;
    case 'todo':
      return <ListTodo className="h-3.5 w-3.5 shrink-0 text-fg-3" />;
    default:
      return <Wrench className="h-3.5 w-3.5 shrink-0 text-fg-3" />;
  }
}

export function eventMatchesSearch(item: ReaderItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (item.kind === 'event') {
    return (item.event.text ?? '').toLowerCase().includes(needle);
  }
  const { call, result } = item;
  const info = call ? summarizeToolCall(call.toolName, call.text) : undefined;
  const haystack = [call?.toolName, call?.toolCallId, info?.summary, call?.text, result?.toolCallId, result?.text]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return haystack.includes(needle);
}

/** Message bubble with hover copy button and safe Markdown rendering. */
export function MessageBubble(props: {
  event: SessionEventRow;
  roleLabel: string;
  timeLabel: string;
  injectedLabel: string;
  copyLabel: string;
  copiedLabel: string;
  expandLabel: string;
  collapseLabel: string;
  codeFallbackLabel: string;
  codeCopyLabel: string;
  searchQuery?: string;
}): ReactNode {
  const { event } = props;
  const text = event.text ?? '';

  if (event.synthetic) {
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 88);
    return (
      <details className="group rounded-control border border-border bg-subtle/60">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-caption text-fg-2 transition-colors hover:bg-accent/40">
          <Badge variant="outline" className="shrink-0 whitespace-nowrap text-[10px]">
            {props.injectedLabel}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-fg-3">
            {highlightMatches(preview, props.searchQuery)}
            {text.length > 88 ? '…' : ''}
          </span>
          <span className="shrink-0 text-3xs text-fg-3 group-open:hidden">{props.expandLabel}</span>
          <span className="hidden shrink-0 text-3xs text-fg-3 group-open:inline">{props.collapseLabel}</span>
          <span className="ml-1 shrink-0 text-3xs tabular-nums text-fg-3">{props.timeLabel}</span>
        </summary>
        <div className="border-t border-border bg-card/60 px-3 py-2">
          <div className="mb-1 flex justify-end">
            <InlineCopyButton text={text} label={props.copyLabel} copiedLabel={props.copiedLabel} showLabel />
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-fg-2">
            {highlightMatches(text, props.searchQuery)}
          </pre>
        </div>
      </details>
    );
  }

  const isUser = event.role === 'user';

  return (
    <div className={cn('group flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
      <div className="flex items-center gap-2 text-caption text-fg-3">
        {isUser ? (
          <>
            <InlineCopyButton
              text={text}
              label={props.copyLabel}
              copiedLabel={props.copiedLabel}
              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            />
            <span className="tabular-nums opacity-75">{props.timeLabel}</span>
            <span className="font-medium text-fg-2">{props.roleLabel}</span>
          </>
        ) : (
          <>
            <span className="font-medium text-fg-2">{props.roleLabel}</span>
            <span className="tabular-nums opacity-75">{props.timeLabel}</span>
            <InlineCopyButton
              text={text}
              label={props.copyLabel}
              copiedLabel={props.copiedLabel}
              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            />
          </>
        )}
      </div>
      <div
        className={cn(
          'max-w-[92%] rounded-panel px-3.5 py-2.5 text-body',
          isUser
            ? 'border border-primary/15 bg-primary/10 text-fg-1'
            : 'border border-border bg-card text-fg-1 shadow-[0_1px_2px_rgba(0,0,0,0.03)] dark:shadow-none',
        )}
      >
        <MarkdownText
          text={text}
          searchQuery={props.searchQuery}
          codeFallbackLabel={props.codeFallbackLabel}
          codeCopyLabel={props.codeCopyLabel}
          copiedLabel={props.copiedLabel}
        />
      </div>
    </div>
  );
}

/** Compact collapsible reasoning block with single-line preview. */
export function ReasoningBlock(props: {
  event: SessionEventRow;
  thinkingLabel: string;
  encryptedLabel: string;
  timeLabel: string;
  copyLabel: string;
  copiedLabel: string;
  codeFallbackLabel: string;
  codeCopyLabel: string;
  searchQuery?: string;
  bulkSignal?: BulkToggleSignal;
}): ReactNode {
  const [open, setOpen] = useState(() => (props.bulkSignal && props.bulkSignal.seq > 0 ? props.bulkSignal.open : false));

  useEffect(() => {
    if (props.bulkSignal && props.bulkSignal.seq > 0) {
      setOpen(props.bulkSignal.open);
    }
  }, [props.bulkSignal?.seq, props.bulkSignal?.open]);

  const rawText = props.event.text ?? '';
  const isEncrypted = rawText === '[encrypted reasoning]';
  const preview = isEncrypted ? props.encryptedLabel : rawText.replace(/\s+/g, ' ').trim();

  return (
    <details open={open} className="overflow-hidden rounded-panel border border-border bg-subtle/45">
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((prev) => !prev);
        }}
        className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-caption text-fg-2 transition-colors hover:bg-accent/40"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-fg-3 transition-transform', open && 'rotate-90')} />
        <Brain className="h-3.5 w-3.5 shrink-0 text-fg-3" />
        <span className="shrink-0 font-medium text-fg-2">{props.thinkingLabel}</span>
        <span className="min-w-0 flex-1 truncate italic text-fg-3">
          {highlightMatches(preview, props.searchQuery)}
        </span>
        <span className="shrink-0 text-3xs tabular-nums text-fg-3">{props.timeLabel}</span>
      </summary>
      <div className="border-t border-border bg-card/60 px-3 py-2.5">
        {!isEncrypted && rawText.trim().length > 0 ? (
          <div className="mb-1 flex justify-end">
            <InlineCopyButton text={rawText} label={props.copyLabel} copiedLabel={props.copiedLabel} showLabel />
          </div>
        ) : null}
        <MarkdownText
          text={isEncrypted ? props.encryptedLabel : rawText}
          searchQuery={props.searchQuery}
          className="text-caption leading-relaxed text-fg-2"
          codeFallbackLabel={props.codeFallbackLabel}
          codeCopyLabel={props.codeCopyLabel}
          copiedLabel={props.copiedLabel}
        />
      </div>
    </details>
  );
}

/** Unified collapsible Tool Card pairing tool_call and tool_result (and handling unpaired events). */
export function ToolPairCard(props: {
  call?: SessionEventRow;
  result?: SessionEventRow;
  cwd?: string;
  timeLabel: string;
  labels: {
    ok: string;
    error: string;
    pending: string;
    orphan: string;
    input: string;
    output: string;
    emptyOutput: string;
    unknownTool: string;
    copyInput: string;
    copyOutput: string;
    copied: string;
  };
  searchQuery?: string;
  bulkSignal?: BulkToggleSignal;
}): ReactNode {
  const [open, setOpen] = useState(() => (props.bulkSignal && props.bulkSignal.seq > 0 ? props.bulkSignal.open : false));
  const [inputOpen, setInputOpen] = useState(true);
  const [outputOpen, setOutputOpen] = useState(true);

  useEffect(() => {
    if (props.bulkSignal && props.bulkSignal.seq > 0) {
      setOpen(props.bulkSignal.open);
    }
  }, [props.bulkSignal?.seq, props.bulkSignal?.open]);

  const toolInfo = useMemo(
    () => (props.call ? summarizeToolCall(props.call.toolName, props.call.text, props.cwd) : undefined),
    [props.call, props.cwd],
  );

  const isError = props.result?.isError === true;
  const toolName = props.call?.toolName ?? props.labels.unknownTool;
  const callId = props.call?.toolCallId ?? props.result?.toolCallId;
  const summaryText = toolInfo?.summary || callId || '';
  const outputText = props.result?.text ?? '';

  return (
    <details
      open={open}
      className={cn(
        'overflow-hidden rounded-panel border bg-card',
        isError ? 'border-destructive/40' : 'border-border',
      )}
    >
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((prev) => !prev);
        }}
        className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-caption transition-colors hover:bg-accent/40"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-fg-3 transition-transform', open && 'rotate-90')} />
        {toolIconFor(toolInfo?.category ?? 'other', Boolean(props.call))}
        {props.call ? (
          <span className="shrink-0 font-mono font-medium text-fg-1">
            {highlightMatches(toolName, props.searchQuery)}
          </span>
        ) : null}
        {summaryText ? (
          <span className="min-w-0 flex-1 truncate font-mono text-fg-2">
            {highlightMatches(summaryText, props.searchQuery)}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          {!props.call ? (
            <Badge variant="outline" className="shrink-0 whitespace-nowrap">
              {props.labels.orphan}
            </Badge>
          ) : null}
          {props.result ? (
            <Badge variant={isError ? 'destructive' : 'success'} className="shrink-0 whitespace-nowrap">
              {isError ? props.labels.error : props.labels.ok}
            </Badge>
          ) : (
            <Badge variant="outline" className="shrink-0 whitespace-nowrap">
              {props.labels.pending}
            </Badge>
          )}
          <span className="text-3xs tabular-nums text-fg-3">{props.timeLabel}</span>
        </div>
      </summary>

      <div className="divide-y divide-border border-t border-border bg-subtle/35">
        {callId ? (
          <div className="flex items-center justify-between px-3 py-1 font-mono text-3xs text-fg-3">
            <span className="truncate">callId: {highlightMatches(callId, props.searchQuery)}</span>
          </div>
        ) : null}

        {props.call ? (
          <details open={inputOpen}>
            <summary
              onClick={(event) => {
                event.preventDefault();
                setInputOpen((prev) => !prev);
              }}
              className="flex cursor-pointer list-none items-center gap-1.5 bg-subtle/50 px-3 py-1.5 text-3xs font-medium text-fg-2 hover:bg-accent/40"
            >
              <ChevronRight className={cn('h-3 w-3 shrink-0 text-fg-3 transition-transform', inputOpen && 'rotate-90')} />
              <span>{props.labels.input}</span>
              <span className="ml-auto">
                <InlineCopyButton
                  text={toolInfo?.prettyInput ?? props.call.text ?? ''}
                  label={props.labels.copyInput}
                  copiedLabel={props.labels.copied}
                />
              </span>
            </summary>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-border/60 bg-background/50 px-3 py-2 font-mono text-[11px] leading-relaxed text-fg-2">
              {highlightMatches(toolInfo?.prettyInput || '{}', props.searchQuery)}
            </pre>
          </details>
        ) : null}

        {props.result ? (
          <details open={outputOpen}>
            <summary
              onClick={(event) => {
                event.preventDefault();
                setOutputOpen((prev) => !prev);
              }}
              className={cn(
                'flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 text-3xs font-medium hover:bg-accent/40',
                isError ? 'bg-destructive/5 text-destructive' : 'bg-subtle/50 text-fg-2',
              )}
            >
              <ChevronRight className={cn('h-3 w-3 shrink-0 opacity-70 transition-transform', outputOpen && 'rotate-90')} />
              <span>{props.labels.output}</span>
              {outputText.length > 0 ? (
                <span className="ml-auto">
                  <InlineCopyButton
                    text={outputText}
                    label={props.labels.copyOutput}
                    copiedLabel={props.labels.copied}
                  />
                </span>
              ) : null}
            </summary>
            {outputText.length > 0 ? (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-border/60 bg-background/50 px-3 py-2 font-mono text-[11px] leading-relaxed text-fg-2">
                {highlightMatches(outputText, props.searchQuery)}
              </pre>
            ) : (
              <div className="border-t border-border/60 bg-background/50 px-3 py-2 text-caption italic text-fg-3">
                {props.labels.emptyOutput}
              </div>
            )}
          </details>
        ) : null}
      </div>
    </details>
  );
}
