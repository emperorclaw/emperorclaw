import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export function MarkdownRenderer({ content, className = "" }: MarkdownRendererProps) {
  return (
    <div className={`markdown-content prose prose-zinc prose-invert max-w-none ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ ...props }) => <h1 className="text-2xl font-bold mb-4 mt-6 text-zinc-100 border-b border-zinc-800 pb-2" {...props} />,
          h2: ({ ...props }) => <h2 className="text-xl font-bold mb-3 mt-5 text-zinc-100" {...props} />,
          h3: ({ ...props }) => <h3 className="text-lg font-bold mb-2 mt-4 text-zinc-100" {...props} />,
          p: ({ ...props }) => <p className="mb-4 leading-relaxed text-zinc-300" {...props} />,
          ul: ({ ...props }) => <ul className="list-disc pl-6 mb-4 text-zinc-300 space-y-1" {...props} />,
          ol: ({ ...props }) => <ol className="list-decimal pl-6 mb-4 text-zinc-300 space-y-1" {...props} />,
          li: ({ ...props }) => <li className="mb-1" {...props} />,
          code: ({ inline, ...props }: any) =>
            inline ? (
              <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-sm font-mono text-indigo-300" {...props} />
            ) : (
              <pre className="bg-zinc-900/80 p-4 rounded-lg border border-zinc-800 overflow-x-auto mb-4 font-mono text-sm text-zinc-300" {...props} />
            ),
          blockquote: ({ ...props }) => <blockquote className="border-l-4 border-indigo-500/50 pl-4 italic mb-4 text-zinc-400 bg-indigo-500/5 py-1" {...props} />,
          table: ({ ...props }) => (
            <div className="overflow-x-auto mb-6">
              <table className="w-full border-collapse border border-zinc-800" {...props} />
            </div>
          ),
          thead: ({ ...props }) => <thead className="bg-zinc-900/80" {...props} />,
          th: ({ ...props }) => <th className="border border-zinc-800 p-2 text-left text-sm font-semibold text-zinc-200" {...props} />,
          td: ({ ...props }) => <td className="border border-zinc-800 p-2 text-sm text-zinc-300" {...props} />,
          a: ({ ...props }) => <a className="text-indigo-400 hover:text-indigo-300 underline" target="_blank" rel="noopener noreferrer" {...props} />,
          hr: ({ ...props }) => <hr className="border-zinc-800 my-8" {...props} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
