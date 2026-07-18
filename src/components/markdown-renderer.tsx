import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

/**
 * Unwrapped unified-diff text (lines starting with +/-, @@ hunk headers)
 * breaks CommonMark parsing: leading +/- read as list bullets and indented
 * code lines each become their own fenced block, producing a mess of empty
 * bullets and fragmented code boxes. Wrap contiguous diff hunks in a fenced
 * ```diff block so they render as one preformatted block instead. Skips
 * spans already inside an existing code fence.
 */
/**
 * Ensure fenced code blocks have blank line before them to prevent
 * react-markdown from nesting <pre> inside <p> (invalid HTML / hydration error).
 */
function ensureBlankBeforeFences(content: string): string {
  return content.replace(/([^\n])\n```/g, '$1\n\n```');
}

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

export function MarkdownRenderer({ content, className = "" }: MarkdownRendererProps) {
  const normalizedContent = ensureBlankBeforeFences(wrapUnifiedDiffHunks(content));
  return (
    <div className={`markdown-content prose prose-zinc prose-invert max-w-none ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ ...props }) => <h1 className="text-2xl font-bold mb-4 mt-6 text-zinc-100 border-b border-zinc-800 pb-2" {...props} />,
          h2: ({ ...props }) => <h2 className="text-xl font-bold mb-3 mt-5 text-zinc-100" {...props} />,
          h3: ({ ...props }) => <h3 className="text-lg font-bold mb-2 mt-4 text-zinc-100" {...props} />,
          p: ({ ...props }) => <div className="mb-4 leading-relaxed text-zinc-300" {...props} />,
          ul: ({ ...props }) => <ul className="list-disc pl-6 mb-4 text-zinc-300 space-y-1" {...props} />,
          ol: ({ ...props }) => <ol className="list-decimal pl-6 mb-4 text-zinc-300 space-y-1" {...props} />,
          li: ({ ...props }) => <li className="mb-1" {...props} />,
          code: ({ inline, ...props }: any) => {
            // react-markdown sometimes passes inline=undefined for edge cases;
            // default to inline to avoid <pre> nesting inside <p>/<div>
            if (inline === false) {
              return <pre className="bg-zinc-900/80 p-4 rounded-lg border border-zinc-800 overflow-x-auto mb-4 font-mono text-sm text-zinc-300"><code {...props} /></pre>;
            }
            return <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-sm font-mono text-indigo-300" {...props} />;
          },
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
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
}
