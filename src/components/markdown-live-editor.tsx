"use client";

import "@mdxeditor/editor/style.css";
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  codeBlockPlugin,
  CodeToggle,
  codeMirrorPlugin,
  CreateLink,
  headingsPlugin,
  InsertCodeBlock,
  InsertTable,
  linkDialogPlugin,
  linkPlugin,
  ListsToggle,
  listsPlugin,
  markdownShortcutPlugin,
  MDXEditor,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  UndoRedo,
  type MDXEditorMethods,
} from "@mdxeditor/editor";
import { forwardRef } from "react";

/**
 * A single live-preview markdown surface (Obsidian-style: edit and read are
 * the same view — headings render as headings while you type, no separate
 * Reading/Split/Source panes). Raw HTML in content is displayed as plain text.
 */
export const MarkdownLiveEditor = forwardRef<MDXEditorMethods, {
  markdown: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  className?: string;
}>(function MarkdownLiveEditor({ markdown, onChange, placeholder, className }, ref) {
  return (
    <MDXEditor
      ref={ref}
      markdown={markdown}
      onChange={onChange}
      placeholder={placeholder}
      suppressHtmlProcessing
      className={`dark-theme dark-editor emperor-mdx-editor ${className || ""}`}
      contentEditableClassName="emperor-mdx-content"
      plugins={[
        headingsPlugin(),
        listsPlugin(),
        quotePlugin(),
        thematicBreakPlugin(),
        linkPlugin(),
        linkDialogPlugin(),
        tablePlugin(),
        codeBlockPlugin({ defaultCodeBlockLanguage: "" }),
        codeMirrorPlugin({
          codeBlockLanguages: {
            "": "Plain text",
            js: "JavaScript",
            ts: "TypeScript",
            tsx: "TypeScript (React)",
            jsx: "JavaScript (React)",
            json: "JSON",
            css: "CSS",
            html: "HTML",
            bash: "Bash",
            python: "Python",
            sql: "SQL",
            yaml: "YAML",
            markdown: "Markdown",
          },
        }),
        markdownShortcutPlugin(),
        toolbarPlugin({
          toolbarContents: () => (
            <>
              <UndoRedo />
              <BlockTypeSelect />
              <BoldItalicUnderlineToggles />
              <CodeToggle />
              <ListsToggle />
              <CreateLink />
              <InsertTable />
              <InsertCodeBlock />
            </>
          ),
        }),
      ]}
    />
  );
});
