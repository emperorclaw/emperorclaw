"use client";

import React, { useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  IconAlertTriangle,
  IconBulb,
  IconExclamationCircle,
  IconInfoCircle,
  IconMessageReport,
} from '@tabler/icons-react';
import {
  MAX_WIDGET_HTML_CHARS,
  parseChartSpec,
  parseStats,
  repairMarkdownTables,
  splitTabs,
} from '@/lib/rich-blocks';
import { ChartBlock } from '@/components/rich/chart-block';
import { StatsBlock } from '@/components/rich/stats-block';
import { TabsBlock } from '@/components/rich/tabs-block';
import { HtmlWidget } from '@/components/rich/html-widget';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  /** Nesting level — tabs render their bodies through this component. */
  depth?: number;
}

/** Tabs inside tabs inside tabs is plenty; deeper fences render as code. */
const MAX_RICH_DEPTH = 3;

/**
 * Ensure fenced code blocks have blank line before them to prevent
 * react-markdown from nesting <pre> inside <p> (invalid HTML / hydration error).
 */
function ensureBlankBeforeFences(content: string): string {
  return content.replace(/([^\n])\n```/g, '$1\n\n```');
}

/**
 * Unwrapped unified-diff text (lines starting with +/-, @@ hunk headers)
 * breaks CommonMark parsing: leading +/- read as list bullets and indented
 * code lines each become their own fenced block, producing a mess of empty
 * bullets and fragmented code boxes. Wrap contiguous diff hunks in a fenced
 * ```diff block so they render as one preformatted block instead. Skips
 * spans already inside an existing code fence.
 */
function wrapUnifiedDiffHunks(content: string): string {
  if (!content.includes("@@ ")) return content;
  const lines = content.split("\n");
  const out: string[] = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (!inFence && /^@@ .*@@/.test(line)) {
      const hunk: string[] = [line];
      i++;
      while (i < lines.length && (/^[+\- ]/.test(lines[i]) || lines[i] === "")) {
        hunk.push(lines[i]);
        i++;
      }
      while (hunk.length > 0 && hunk[hunk.length - 1] === "") hunk.pop();
      out.push("```diff", ...hunk, "```");
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

// ─── GitHub-style alerts: > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]

type CalloutType = 'note' | 'tip' | 'important' | 'warning' | 'caution';

const CALLOUTS: Record<CalloutType, { label: string; icon: typeof IconInfoCircle; className: string; iconClass: string }> = {
  note: { label: 'Note', icon: IconInfoCircle, className: 'border-sky-500/40 bg-sky-500/[0.06]', iconClass: 'text-sky-400' },
  tip: { label: 'Tip', icon: IconBulb, className: 'border-emerald-500/40 bg-emerald-500/[0.06]', iconClass: 'text-emerald-400' },
  important: { label: 'Important', icon: IconMessageReport, className: 'border-violet-500/40 bg-violet-500/[0.07]', iconClass: 'text-violet-400' },
  warning: { label: 'Warning', icon: IconAlertTriangle, className: 'border-amber-500/40 bg-amber-500/[0.07]', iconClass: 'text-amber-400' },
  caution: { label: 'Caution', icon: IconExclamationCircle, className: 'border-rose-500/40 bg-rose-500/[0.07]', iconClass: 'text-rose-400' },
};

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

/** Tag `> [!TYPE] optional title` blockquotes so the renderer can draw a callout. */
function remarkCallouts() {
  return (tree: MdNode) => {
    const visit = (node: MdNode) => {
      if (node.type === 'blockquote') {
        const paragraph = node.children?.[0];
        const first = paragraph?.type === 'paragraph' ? paragraph.children?.[0] : undefined;
        const match = first?.type === 'text' ? /^\[!(note|tip|important|warning|caution)\][ \t]*([^\n]*)\n?/i.exec(first.value ?? '') : null;
        if (first && match) {
          first.value = (first.value ?? '').slice(match[0].length);
          if (!first.value && paragraph?.children?.[1]?.type === 'break') paragraph.children.splice(1, 1);
          node.data = { ...node.data, hProperties: { ...node.data?.hProperties, 'data-callout': match[1].toLowerCase(), 'data-callout-title': match[2].trim() || undefined } };
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

// ─── Fenced blocks ─────────────────────────────────────────────────────────

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

function hastText(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

function fenceOf(node: HastNode | undefined): { language: string; code: string } | null {
  const codeEl = node?.children?.find((child) => child.type === 'element' && child.tagName === 'code');
  if (!codeEl) return null;
  const classes = Array.isArray(codeEl.properties?.className) ? codeEl.properties!.className as string[] : [];
  const language = classes.find((c) => typeof c === 'string' && c.startsWith('language-'))?.slice('language-'.length) ?? '';
  return { language: language.toLowerCase(), code: hastText(codeEl).replace(/\n$/, '') };
}

/** A plain styled element. Drops react-markdown's `node` prop so it never
 *  reaches the DOM as an attribute. */
function styled<T extends keyof React.JSX.IntrinsicElements>(Tag: T, className: string) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Styled = ({ node, ...props }: React.JSX.IntrinsicElements[T] & { node?: unknown }) => React.createElement(Tag, { className, ...props });
  Styled.displayName = `Markdown.${String(Tag)}`;
  return Styled;
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  return (
    <div className="not-prose group/code relative mb-4 min-w-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/80">
      {language && (
        <div className="border-b border-zinc-800/80 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">{language}</div>
      )}
      <pre className="overflow-x-auto p-3.5 font-mono text-[13px] leading-relaxed text-zinc-300"><code>{code}</code></pre>
    </div>
  );
}

function RichFence({ language, code, depth }: { language: string; code: string; depth: number }) {
  if (depth < MAX_RICH_DEPTH) {
    if (language === 'chart') {
      const spec = parseChartSpec(code);
      if (spec) return <ChartBlock spec={spec} source={code} />;
    } else if (language === 'stats' || language === 'kpi') {
      const items = parseStats(code);
      if (items) return <StatsBlock items={items} />;
    } else if (language === 'tabs') {
      const tabs = splitTabs(code);
      if (tabs) return <TabsBlock tabs={tabs} renderMarkdown={(content) => <MarkdownRenderer content={content} depth={depth + 1} />} />;
    } else if ((language === 'html' || language === 'widget') && code.trim() && code.length <= MAX_WIDGET_HTML_CHARS) {
      return <HtmlWidget html={code} />;
    }
  }
  return <CodeBlock language={language} code={code} />;
}

export function MarkdownRenderer({ content, className = "", depth = 0 }: MarkdownRendererProps) {
  const normalizedContent = ensureBlankBeforeFences(repairMarkdownTables(wrapUnifiedDiffHunks(content)));

  const components = useMemo<Components>(() => ({
    h1: styled('h1', 'text-2xl font-bold mb-4 mt-6 text-zinc-100 border-b border-zinc-800 pb-2'),
    h2: styled('h2', 'text-xl font-bold mb-3 mt-5 text-zinc-100'),
    h3: styled('h3', 'text-lg font-bold mb-2 mt-4 text-zinc-100'),
    p: styled('div', 'mb-4 leading-relaxed text-zinc-300'),
    ul: styled('ul', 'list-disc pl-6 mb-4 text-zinc-300 space-y-1'),
    ol: styled('ol', 'list-decimal pl-6 mb-4 text-zinc-300 space-y-1'),
    li: styled('li', 'mb-1'),
    // Fenced blocks arrive as <pre><code class="language-x">. Rich languages
    // get their renderer; everything else a proper code block.
    pre: ({ node }) => {
      const fence = fenceOf(node as HastNode | undefined);
      if (!fence) return <CodeBlock language="" code={hastText(node as HastNode | undefined)} />;
      return <RichFence language={fence.language} code={fence.code} depth={depth} />;
    },
    code: styled('code', 'bg-zinc-800 px-1.5 py-0.5 rounded text-sm font-mono text-indigo-300'),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    blockquote: ({ node, children, ...props }) => {
      const type = (props as Record<string, unknown>)['data-callout'] as CalloutType | undefined;
      const callout = type ? CALLOUTS[type] : undefined;
      if (callout) {
        const title = (props as Record<string, unknown>)['data-callout-title'] as string | undefined;
        const Icon = callout.icon;
        return (
          <div role="note" className={`not-prose mb-4 rounded-lg border-l-[3px] px-4 py-2.5 text-sm text-zinc-300 [&>div:last-child]:mb-0 ${callout.className}`}>
            <div className={`mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider ${callout.iconClass}`}>
              <Icon className="h-4 w-4" />
              {title || callout.label}
            </div>
            {children}
          </div>
        );
      }
      return <blockquote className="border-l-4 border-indigo-500/50 pl-4 italic mb-4 text-zinc-400 bg-indigo-500/5 py-1" {...props}>{children}</blockquote>;
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    table: ({ node, ...props }) => (
      <div className="not-prose mb-4 max-h-[520px] w-full min-w-0 overflow-auto rounded-lg border border-zinc-800">
        <table className="w-full border-collapse text-sm tabular-nums" {...props} />
      </div>
    ),
    thead: styled('thead', 'sticky top-0 z-[1] bg-zinc-900'),
    tr: styled('tr', 'border-b border-zinc-800/80 last:border-0 transition-colors hover:bg-zinc-800/30 even:bg-zinc-900/30'),
    th: styled('th', 'whitespace-nowrap border-b border-zinc-800 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-400'),
    td: styled('td', 'px-3 py-2 align-top text-zinc-300'),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    a: ({ node, ...props }) => <a className="text-indigo-400 hover:text-indigo-300 underline" target="_blank" rel="noopener noreferrer" {...props} />,
    hr: styled('hr', 'border-zinc-800 my-8'),
    // Agents sometimes link a file that only exists on their own machine
    // (`/tmp/chart.png`, `file://…`). The browser can't load that, so say so
    // instead of showing a broken-image icon.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    img: ({ node, src, alt, ...props }) => {
      const url = typeof src === 'string' ? src : '';
      const loadable = /^(https?:|data:image\/|blob:)/i.test(url) || (url.startsWith('/') && !url.startsWith('//') && /^\/(api|_next|icon)/.test(url));
      if (!loadable) {
        return (
          <span className="not-prose inline-flex items-center gap-1.5 rounded-md border border-dashed border-zinc-700 px-2 py-1 text-xs text-zinc-500" title={url}>
            Image unavailable{alt ? `: ${alt}` : ''}
          </span>
        );
      }
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={url} alt={alt ?? ''} loading="lazy" className="my-2 max-w-full rounded-lg border border-zinc-800" {...props} />;
    },
  }), [depth]);

  return (
    // Nested renderers (tab bodies) skip the `prose` hook class so chat
    // surfaces' `[&_.prose]:max-w-prose` never squeezes a chart inside a tab.
    <div className={`markdown-content ${depth === 0 ? 'prose prose-zinc prose-invert' : ''} max-w-none min-w-0 ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkCallouts]} components={components}>
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
}
