import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface DocsMarkdownRendererProps {
  content: string;
}

export function DocsMarkdownRenderer({ content }: DocsMarkdownRendererProps) {
  return (
    <div className="prose prose-invert max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-a:text-indigo-400 prose-a:no-underline hover:prose-a:underline prose-code:text-indigo-300 prose-code:bg-indigo-500/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none prose-pre:bg-zinc-950/50 prose-pre:border prose-pre:border-zinc-800 prose-pre:rounded-2xl">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="text-3xl font-bold mb-8 mt-0 text-white tracking-tight">{children}</h1>,
          h2: ({ children }) => <h2 className="text-2xl font-semibold mb-4 mt-12 text-zinc-100 border-b border-zinc-800 pb-2">{children}</h2>,
          h3: ({ children }) => <h3 className="text-xl font-semibold mb-3 mt-8 text-zinc-200">{children}</h3>,
          p: ({ children }) => <p className="mb-6 text-zinc-400 leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-6 space-y-2 mb-6 text-zinc-400">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-6 space-y-2 mb-6 text-zinc-400">{children}</ol>,
          li: ({ children }) => <li className="pl-1">{children}</li>,
          code: ({ children, className }) => {
            const isMatch = /language-(\w+)/.exec(className || '');
            const isInline = !className;
            if (isInline) {
              return <code className="bg-zinc-800/50 text-indigo-300 px-1.5 py-0.5 rounded text-sm font-medium border border-zinc-700/50">{children}</code>;
            }
            return (
              <div className="relative group my-8">
                <div className="absolute -inset-2 bg-gradient-to-r from-indigo-500/10 to-transparent blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-3xl" />
                <pre className="relative bg-zinc-950 border border-zinc-800 rounded-2xl p-6 overflow-x-auto shadow-2xl font-mono text-sm leading-relaxed scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent">
                  <div className="flex items-center justify-between mb-4 border-b border-zinc-800/50 pb-2">
                    <span className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">{isMatch ? isMatch[1] : 'code'}</span>
                    <div className="flex gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-zinc-800" />
                      <div className="w-2.5 h-2.5 rounded-full bg-zinc-800" />
                      <div className="w-2.5 h-2.5 rounded-full bg-zinc-800" />
                    </div>
                  </div>
                  <code className="text-indigo-100/90">{children}</code>
                </pre>
              </div>
            );
          },
          a: ({ href, children }) => (
            <a
              href={href}
              className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
              target={href?.startsWith('http') ? '_blank' : undefined}
              rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-10 rounded-2xl border border-zinc-800 bg-zinc-900/20 shadow-lg">
              <table className="w-full text-sm border-collapse">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-zinc-900/50 border-b border-zinc-800 font-semibold text-zinc-200">{children}</thead>,
          th: ({ children }) => <th className="text-left p-4 border-b border-zinc-800/50 uppercase tracking-wider text-xs">{children}</th>,
          td: ({ children }) => <td className="p-4 border-b border-zinc-800/20 text-zinc-400">{children}</td>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-indigo-500/50 bg-indigo-500/5 pl-6 py-4 pr-4 rounded-r-2xl italic my-8 text-zinc-300 shadow-inner">
              {children}
            </blockquote>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}