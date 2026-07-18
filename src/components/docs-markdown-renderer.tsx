import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { type Components } from 'react-markdown';
import { IconCopy, IconCheck, IconInfoCircle, IconAlertTriangle, IconBulb } from "@tabler/icons-react";
import { useState } from 'react';

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
      <pre className="relative bg-zinc-950 border border-zinc-800 rounded-2xl p-6 overflow-x-auto shadow-2xl font-mono text-sm leading-relaxed scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent">
        <div className="flex items-center justify-between mb-4 border-b border-zinc-800/50 pb-2">
          <span className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">{language}</span>
          <div className="flex items-center gap-3">
            <button
              onClick={onCopy}
              className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-500 hover:text-zinc-100 hover:border-zinc-700 transition-all active:scale-95"
            >
              {copied ? <IconCheck className="w-3.5 h-3.5 text-emerald-400" /> : <IconCopy className="w-3.5 h-3.5" />}
            </button>
            <div className="flex gap-1.5 pr-1">
              <div className="w-2 h-2 rounded-full bg-zinc-800" />
              <div className="w-2 h-2 rounded-full bg-zinc-800" />
              <div className="w-2 h-2 rounded-full bg-zinc-800" />
            </div>
          </div>
        </div>
        <code className="text-indigo-100/90">{children}</code>
      </pre>
    </div>
  );
};

export function DocsMarkdownRenderer({ content }: DocsMarkdownRendererProps) {
  return (
    <div className="prose prose-invert max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-a:text-indigo-400 prose-a:no-underline hover:prose-a:underline prose-code:text-indigo-300 prose-code:bg-indigo-500/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none prose-pre:bg-zinc-950/50 prose-pre:border prose-pre:border-zinc-800 prose-pre:rounded-2xl">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="text-4xl font-bold mb-10 mt-0 text-white tracking-tight">{children}</h1>,
          h2: ({ children }) => <h2 className="text-2xl font-semibold mb-6 mt-16 text-zinc-100 border-b border-zinc-800/50 pb-3">{children}</h2>,
          h3: ({ children }) => <h3 className="text-xl font-semibold mb-4 mt-10 text-zinc-200">{children}</h3>,
          p: ({ children }) => <p className="mb-6 text-zinc-400 leading-relaxed text-[16px]">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-6 space-y-3 mb-8 text-zinc-400">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-6 space-y-3 mb-8 text-zinc-400">{children}</ol>,
          li: ({ children }) => <li className="pl-1">{children}</li>,
          code: ({ children, className }) => {
            const isInline = !className;
            if (isInline) {
              return <code className="bg-zinc-800/50 text-indigo-300 px-1.5 py-0.5 rounded text-[13px] font-medium border border-zinc-700/50">{children}</code>;
            }
            return <CodeBlock className={className}>{children}</CodeBlock>;
          },
          blockquote: ({ children }) => {
            const text = String(children);
            const isNote = text.includes('[!NOTE]');
            const isTip = text.includes('[!TIP]');
            const isWarning = text.includes('[!WARNING]');
            
            let icon = <IconInfoCircle className="w-5 h-5" />;
            let borderColor = 'border-indigo-500/50';
            let bgColor = 'bg-indigo-500/5';
            let textColor = 'text-indigo-300';
            let label = 'Note';

            if (isTip) {
              icon = <IconBulb className="w-5 h-5" />;
              borderColor = 'border-emerald-500/50';
              bgColor = 'bg-emerald-500/5';
              textColor = 'text-emerald-300';
              label = 'Tip';
            } else if (isWarning) {
              icon = <IconAlertTriangle className="w-5 h-5" />;
              borderColor = 'border-rose-500/50';
              bgColor = 'bg-rose-500/5';
              textColor = 'text-rose-300';
              label = 'Warning';
            }

            const cleanChildren = Array.isArray(children) 
              ? children.map(c => typeof c === 'string' ? c.replace(/\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\n?/, '') : c)
              : typeof children === 'string' ? children.replace(/\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\n?/, '') : children;

            return (
              <div className={`my-8 border-l-4 ${borderColor} ${bgColor} p-6 rounded-r-2xl shadow-inner relative overflow-hidden group`}>
                <div className={`flex items-center gap-3 mb-3 ${textColor} font-semibold text-sm uppercase tracking-wider`}>
                  {icon}
                  <span>{label}</span>
                </div>
                <div className="text-zinc-300 italic leading-relaxed">
                  {cleanChildren}
                </div>
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