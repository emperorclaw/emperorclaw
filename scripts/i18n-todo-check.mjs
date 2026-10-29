#!/usr/bin/env node
// Fails (exit 1) while messages/zh-CN.json still holds untranslated placeholders:
// values starting with "__TODO__ ", added with each new English key until the
// Simplified Chinese translation lands. Not part of the unit suite yet; run it
// before a release that ships the translated screens:
//   node scripts/i18n-todo-check.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "__TODO__";
const file = join(dirname(fileURLToPath(import.meta.url)), "..", "messages", "zh-CN.json");
const messages = JSON.parse(readFileSync(file, "utf8"));

const pending = [];
(function walk(tree, prefix) {
    for (const [key, value] of Object.entries(tree)) {
        const id = prefix ? `${prefix}.${key}` : key;
        if (typeof value === "string") {
            if (value.trimStart().startsWith(MARKER)) pending.push(id);
        } else if (value && typeof value === "object") {
            walk(value, id);
        }
    }
})(messages, "");

if (pending.length > 0) {
    const byNamespace = new Map();
    for (const id of pending) {
        const namespace = id.split(".")[0];
        byNamespace.set(namespace, (byNamespace.get(namespace) ?? 0) + 1);
    }
    console.error(`messages/zh-CN.json: ${pending.length} untranslated ${MARKER} values`);
    for (const [namespace, count] of byNamespace) console.error(`  ${namespace}: ${count}`);
    for (const id of pending.slice(0, 20)) console.error(`  - ${id}`);
    if (pending.length > 20) console.error(`  … and ${pending.length - 20} more`);
    process.exit(1);
}
console.log("messages/zh-CN.json: no untranslated values");
