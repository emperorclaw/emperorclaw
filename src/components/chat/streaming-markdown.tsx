"use client";
import { memo } from "react";
import { MarkdownRenderer } from "@/components/markdown-renderer";

import { streamBlocks } from "@/lib/chat/stream-blocks";

export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }) {
    return <div className="space-y-2.5 text-sm leading-relaxed" data-streaming-response>
        {streamBlocks(text).map((content, index) => <MarkdownRenderer key={index} content={content} density="compact" allowWidgets={false} allowImages={false} />)}
    </div>;
});
