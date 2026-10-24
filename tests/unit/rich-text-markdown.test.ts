import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownRenderer } from "../../src/components/markdown-renderer";
import { RichText } from "../../src/components/rich-text";

const render = (content: string, props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(MarkdownRenderer, { content, density: "compact", allowWidgets: false, ...props }));

test("raw HTML is never rendered as elements", () => {
    const html = render('Hello <script>alert(1)</script> <img src=x onerror="alert(2)"> <b>bold</b>');
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<img[^>]*onerror/i);
    assert.doesNotMatch(html, /<b>/);
    assert.match(html, /&lt;script&gt;/, "raw tags are shown as text");
});

test("RichText drops script elements and turns details into readable text", () => {
    const html = renderToStaticMarkup(createElement(RichText, { content: "Ok <script>steal()</script>\n\n<details><summary>More</summary>Hidden part</details>" }));
    assert.doesNotMatch(html, /script|steal/);
    assert.match(html, /<strong>More<\/strong>/);
    assert.match(html, /Hidden part/);
});

test("links open safely and unsafe URLs are removed", () => {
    const html = render("[site](https://example.com) [bad](javascript:alert(1)) [data](data:text/html,<script>x</script>)");
    assert.match(html, /<a [^>]*href="https:\/\/example.com"[^>]*>/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.match(html, /target="_blank"/);
    assert.doesNotMatch(html, /javascript:/i);
    assert.doesNotMatch(html, /href="data:/i);
});

test("compact density scales headings down", () => {
    const html = render("# Big heading\n\n## Section");
    assert.match(html, /<h1 class="[^"]*text-base/);
    assert.doesNotMatch(html, /text-2xl/);
});

test("task lists, tables and code blocks render", () => {
    const html = render("- [x] done\n- [ ] todo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```bash\necho hi\n```");
    assert.match(html, /aria-label="Done"/);
    assert.match(html, /aria-label="Not done"/);
    assert.doesNotMatch(html, /<input/);
    assert.match(html, /<table/);
    assert.match(html, /<pre[^>]*><code>echo hi/);
});

test("html widgets stay off in agent text and show as code", () => {
    const html = render("```html\n<button>x</button>\n```");
    assert.doesNotMatch(html, /<iframe/);
    assert.match(html, /&lt;button&gt;x&lt;\/button&gt;/);
});
