import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { type Components } from 'react-markdown';
import { IconCopy, IconCheck, IconInfoCircle, IconAlertTriangle, IconBulb, IconAlertOctagon } from "@tabler/icons-react";
import { Children, cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from 'react';

interface DocsMarkdownRendererProps {
  content: string;
}

const CodeBlock = ({ children, className }: { children: any; className?: string }) => {
  const [copied, setCopied] = useState(false);
  const isMatch = /language-(\w+)/.exec(className || '');
  const language = isMatch ? isMatch[1] : 'code';

  const onCopy = () => {
    navigator.clipboard.writeText(String(children).replace(/\n$/, ''));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group my-8">
      <div className="absolute -inset-2 bg-gradient-to-r from-indigo-500/10 to-transparent blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-3xl" />
      <pre className="relative bg-muted border border-border rounded-2xl p-6 overflow-x-auto shadow-2xl font-mono text-sm leading-relaxed scrollbar-thin">
        <div className="flex items-center justify-between mb-4 border-b border-border pb-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">{language}</span>
          <div className="flex items-center gap-3">
            <button
              onClick={onCopy}
              className="p-1.5 rounded-lg bg-accent border border-border text-muted-foreground hover:text-foreground hover:border-ring transition-all active:scale-95"
            >
              {copied ? <IconCheck className="w-3.5 h-3.5 text-emerald-400" /> : <IconCopy className="w-3.5 h-3.5" />}
            </button>
            <div className="flex gap-1.5 pr-1">
              <div className="w-2 h-2 rounded-full bg-border" />
              <div className="w-2 h-2 rounded-full bg-border" />
              <div className="w-2 h-2 rounded-full bg-border" />
            </div>
          </div>
        </div>
        <code className="text-foreground/90">{children}</code>
      </pre>
    </div>
  );
};


// GitHub-style callouts: a blockquote starting with [!NOTE], [!TIP],
// [!IMPORTANT], [!WARNING] or [!CAUTION]. By the time it renders, the marker
// sits inside a paragraph element, so read and strip it through the tree.
const CALLOUT_MARKER = /\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/;

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return '';
}

function stripMarker(node: ReactNode): ReactNode {
  let done = false;
  const walk = (n: ReactNode): ReactNode => {
    if (done) return n;
    if (typeof n === 'string') {
      if (CALLOUT_MARKER.test(n)) { done = true; return n.replace(CALLOUT_MARKER, ''); }
      return n;
    }
    if (Array.isArray(n)) return n.map(walk);
    if (isValidElement(n)) {
      const el = n as ReactElement<{ children?: ReactNode }>;
      return cloneElement(el, undefined, ...Children.toArray(walk(el.props.children)));
    }
    return n;
  };
  return walk(node);
}

const CALLOUTS = {
  NOTE: { label: 'Note', icon: IconInfoCircle, border: 'border-indigo-500/50', bg: 'bg-indigo-500/5', text: 'text-indigo-600 dark:text-indigo-300' },
  TIP: { label: 'Tip', icon: IconBulb, border: 'border-emerald-500/50', bg: 'bg-emerald-500/5', text: 'text-emerald-600 dark:text-emerald-300' },
  IMPORTANT: { label: 'Important', icon: IconAlertOctagon, border: 'border-violet-500/50', bg: 'bg-violet-500/5', text: 'text-violet-600 dark:text-violet-300' },
  WARNING: { label: 'Warning', icon: IconAlertTriangle, border: 'border-amber-500/50', bg: 'bg-amber-500/5', text: 'text-amber-600 dark:text-amber-300' },
  CAUTION: { label: 'Caution', icon: IconAlertTriangle, border: 'border-rose-500/50', bg: 'bg-rose-500/5', text: 'text-rose-600 dark:text-rose-300' },
} as const;

export function DocsMarkdownRenderer({ content }: DocsMarkdownRendererProps) {
  return (
    <div className="prose dark:prose-invert max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-a:text-primary prose-a:no-underline hover:prose-a:underline prose-code:bg-primary/10 prose-code:text-primary prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none prose-pre:bg-muted prose-pre:border prose-pre:border-border prose-pre:rounded-2xl">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="text-4xl font-bold mb-10 mt-0 text-foreground tracking-tight">{children}</h1>,
          h2: ({ children }) => <h2 className="text-2xl font-semibold mb-6 mt-16 text-foreground border-b border-border pb-3">{children}</h2>,
          h3: ({ children }) => <h3 className="text-xl font-semibold mb-4 mt-10 text-foreground">{children}</h3>,
          p: ({ children }) => <p className="mb-6 text-zinc-300 leading-relaxed text-[16px]">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-6 space-y-3 mb-8 text-zinc-300">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-6 space-y-3 mb-8 text-zinc-300">{children}</ol>,
          li: ({ children }) => <li className="pl-1">{children}</li>,
          // Tables scroll sideways on narrow screens instead of squeezing their columns.
          table: ({ children }) => (
            <div className="not-prose my-8 overflow-x-auto rounded-xl border border-border">
              <table className="w-full border-collapse text-left text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
          th: ({ children }) => <th className="border-b border-border px-4 py-2.5 font-semibold text-foreground">{children}</th>,
          td: ({ children }) => <td className="border-b border-border px-4 py-2.5 align-top leading-relaxed text-zinc-300">{children}</td>,
          tr: ({ children }) => <tr className="last:[&>td]:border-b-0">{children}</tr>,
          code: ({ children, className }) => {
            const isInline = !className;
            if (isInline) {
              return <code className="bg-muted text-primary px-1.5 py-0.5 rounded text-[13px] font-medium border border-border">{children}</code>;
            }
            return <CodeBlock className={className}>{children}</CodeBlock>;
          },
          blockquote: ({ children }) => {
            const kind = (CALLOUT_MARKER.exec(nodeText(children))?.[1] ?? null) as keyof typeof CALLOUTS | null;
            if (!kind) {
              return <blockquote className="my-6 border-l-4 border-border pl-5 text-zinc-400 italic">{children}</blockquote>;
            }
            const callout = CALLOUTS[kind];
            const Icon = callout.icon;
            return (
              <div className={`not-prose my-8 border-l-4 ${callout.border} ${callout.bg} rounded-r-2xl p-5 sm:p-6`}>
                <div className={`mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider ${callout.text}`}>
                  <Icon className="h-5 w-5" />
                  <span>{callout.label}</span>
                </div>
                <div className="leading-relaxed text-zinc-300 [&>p:last-child]:mb-0">{stripMarker(children)}</div>
              </div>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
