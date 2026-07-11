"use client";

import "@mdxeditor/editor/style.css";
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  codeBlockPlugin,
  CodeToggle,
  CreateLink,
  diffSourcePlugin,
  DiffSourceToggleWrapper,
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
 * Reading/Split/Source panes). Includes a lightweight source-view toggle in
 * the toolbar for raw-markdown power edits, instead of a permanent third pane.
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
        codeBlockPlugin({ defaultCodeBlockLanguage: "text" }),
        markdownShortcutPlugin(),
        diffSourcePlugin({ viewMode: "rich-text" }),
        toolbarPlugin({
          toolbarContents: () => (
            <DiffSourceToggleWrapper>
              <UndoRedo />
              <BlockTypeSelect />
              <BoldItalicUnderlineToggles />
              <CodeToggle />
              <ListsToggle />
              <CreateLink />
              <InsertTable />
              <InsertCodeBlock />
            </DiffSourceToggleWrapper>
          ),
        }),
      ]}
    />
  );
});
