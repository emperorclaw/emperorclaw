/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Guardrail for the stretched-link press bug (v0.31.1): the global press
 * feedback scales every `a[href]` on :active, and a non-none `scale` makes the
 * anchor the containing block of its absolutely positioned `::after`. A row
 * whose click target is that overlay (`after:absolute after:inset-0`) therefore
 * collapses to the width of its text on pointer-down, the pointer ends up
 * outside the link, and the click never navigates.
 *
 * Invariant: every anchor that stretches an overlay opts out with
 * `data-stretched-link`, its row marks itself `data-press-row` (the row answers
 * the press with a background instead), and the press rule excludes the marker.
 */
const assert = require("node:assert/strict");
const { readFileSync, readdirSync, statSync } = require("node:fs");
const { join, resolve, relative } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

/** Every file under src/ with the given extensions. */
function walk(dir, exts, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

/**
 * JSX opening tags, scanned brace/quote-aware so `onClick={() => x}` and class
 * strings containing `>` do not terminate the tag early. Returns the raw text
 * of each opening tag.
 */
function openingTags(source) {
  const tags = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== "<" || !/[A-Za-z]/.test(source[i + 1] ?? "")) continue;
    let depth = 0;
    let quote = null;
    for (let j = i + 1; j < source.length; j += 1) {
      const ch = source[j];
      if (quote) {
        if (ch === "\\") { j += 1; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "{") { depth += 1; continue; }
      if (ch === "}") { depth -= 1; continue; }
      if (ch === ">" && depth === 0) { tags.push(source.slice(i, j + 1)); i = j; break; }
    }
  }
  return tags;
}

const STRETCH_CLASSES = ["after:absolute", "after:inset-0"];

test("every stretched-overlay link opts out of the scale press", () => {
  const offenders = [];
  let stretched = 0;
  for (const file of walk(resolve(root, "src"), [".tsx"])) {
    const source = readFileSync(file, "utf8");
    for (const tag of openingTags(source)) {
      if (!STRETCH_CLASSES.every((cls) => tag.includes(cls))) continue;
      stretched += 1;
      if (!tag.includes("data-stretched-link")) offenders.push(`${relative(root, file)}: ${tag.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  assert.equal(offenders.length, 0, `stretched links must carry data-stretched-link:\n${offenders.join("\n")}`);
  assert.ok(stretched >= 2, `expected the views row and needs-attention row to use stretched links, found ${stretched}`);
});

test("a row hosting a stretched link marks itself data-press-row", () => {
  const offenders = [];
  for (const file of walk(resolve(root, "src"), [".tsx"])) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("data-stretched-link")) continue;
    if (!source.includes("data-press-row")) offenders.push(relative(root, file));
  }
  assert.equal(offenders.length, 0, `files with a stretched link must mark its row data-press-row: ${offenders.join(", ")}`);
});

test("the press rule excludes data-stretched-link and the row answers the press", () => {
  const css = read("src/app/globals.css");
  const pressRule = css.match(/:is\([^)]*\)\s*:is\(button, a\[href\][^{]*:active\s*\{[^}]*\}/);
  assert.ok(pressRule, "the global :active press rule should still exist");
  assert.match(pressRule[0], /\[data-stretched-link\]/, "the scale press must exclude [data-stretched-link]");
  assert.match(pressRule[0], /scale: 0\.97/, "the scale press must still fire for ordinary controls");
  assert.match(
    css,
    /\[data-press-row\]:has\(a\[data-stretched-link\]:active\)\s*\{[^}]*background-color/,
    "the row must answer the press itself, without scaling the link",
  );
});
