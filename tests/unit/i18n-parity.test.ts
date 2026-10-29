import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
// The ICU parser next-intl itself uses (a dependency of next-intl/use-intl).
import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { MOBILE_TABS, navSections } from "../../src/lib/navigation";
import { SETTINGS_SECTIONS, settingsItemKey } from "../../src/lib/settings-navigation";
import { SCENE_CAPTION_KEYS, SCENE_CAPTION_PREFIXES } from "../../src/components/team-dashboard/scene-copy-keys";
import { BUCKET_LABEL } from "../../src/lib/live-office";
import { STATUS_LABEL, ZONES } from "../../src/lib/team-scene";
import { ATTENTION_GROUP_LABEL } from "../../src/lib/attention-rules";
import { GO_CHORDS } from "../../src/lib/keyboard-shortcuts";
import { SEARCH_TYPE_LABELS } from "../../src/lib/search-query";

const ROOT = path.join(__dirname, "..", "..");
type Tree = { [key: string]: string | Tree };
const load = (file: string) => JSON.parse(readFileSync(path.join(ROOT, "messages", file), "utf8")) as Tree;
const en = load("en.json");
const zh = load("zh-CN.json");

function flatten(tree: Tree, prefix = ""): Map<string, string> {
    const out = new Map<string, string>();
    for (const [key, value] of Object.entries(tree)) {
        const id = prefix ? `${prefix}.${key}` : key;
        if (typeof value === "string") out.set(id, value);
        else for (const [k, v] of flatten(value, id)) out.set(k, v);
    }
    return out;
}

const enFlat = flatten(en);
const zhFlat = flatten(zh);
const enMessage = (key: string) => {
    const value = enFlat.get(key);
    assert.ok(value !== undefined, `en.json has no ${key}`);
    return value;
};

/** Every argument and tag name an ICU message uses (plural/select branches included). */
function placeholders(elements: MessageFormatElement[], out = new Set<string>()): Set<string> {
    for (const el of elements) {
        if (el.type === TYPE.argument || el.type === TYPE.number || el.type === TYPE.date || el.type === TYPE.time) out.add(el.value);
        if (el.type === TYPE.plural || el.type === TYPE.select) {
            out.add(el.value);
            for (const option of Object.values(el.options)) placeholders(option.value, out);
        }
        if (el.type === TYPE.tag) {
            out.add(`<${el.value}>`);
            placeholders(el.children, out);
        }
    }
    return out;
}

test("en and zh-CN have exactly the same keys", () => {
    const missing = [...enFlat.keys()].filter((key) => !zhFlat.has(key));
    const extra = [...zhFlat.keys()].filter((key) => !enFlat.has(key));
    assert.deepEqual(missing, [], `missing in zh-CN.json: ${missing.join(", ")}`);
    assert.deepEqual(extra, [], `only in zh-CN.json: ${extra.join(", ")}`);
});

test("no message is empty", () => {
    for (const [file, flat] of [["en", enFlat], ["zh-CN", zhFlat]] as const) {
        for (const [key, value] of flat) assert.ok(value.trim().length > 0, `${file}: ${key} is empty`);
    }
});

test("every message is valid ICU and both locales use the same placeholders", () => {
    for (const [key, enValue] of enFlat) {
        const zhValue = zhFlat.get(key) ?? "";
        let enArgs: Set<string>;
        let zhArgs: Set<string>;
        assert.doesNotThrow(() => { enArgs = placeholders(parse(enValue)); }, `en: ${key} is not valid ICU`);
        assert.doesNotThrow(() => { zhArgs = placeholders(parse(zhValue)); }, `zh-CN: ${key} is not valid ICU`);
        assert.deepEqual([...zhArgs!].sort(), [...enArgs!].sort(), `${key}: placeholders differ`);
    }
});

test("Chinese copy follows the glossary (messages/GLOSSARY.zh-CN.md)", () => {
    // Banned variant → the glossary term to use instead.
    const banned: Record<string, string> = {
        "代理": "智能体 (agent)",
        "工作空间": "工作区 (workspace)",
        "管道": "流水线 (pipeline)",
        "例程": "例行任务 (routine)",
        "收件匣": "收件箱 (inbox)",
        "设定": "设置 (settings)",
        "皇帝": "Emperor (product name stays English)",
        "帝王": "Emperor (product name stays English)",
        "工件": "文件 (artifact/file)",
        "顾客": "客户 (customer)",
    };
    for (const [key, value] of zhFlat) {
        for (const [word, use] of Object.entries(banned)) {
            assert.ok(!value.includes(word), `zh-CN ${key} uses "${word}"; use ${use}`);
        }
        // Full-width punctuation in Chinese sentences: no ASCII "," ";" "?" "!" after a CJK character.
        assert.ok(!/[一-鿿][,;?!]/.test(value), `zh-CN ${key} uses ASCII punctuation after Chinese text: ${value}`);
    }
});

/**
 * Every English message (pauseAll, livePill, updateBanner, versionBanner,
 * errors, time, home, inbox, …) as verified against the HEAD source literals
 * it replaced when phase 1 moved the copy into en.json. Changing English copy
 * is deliberate: update the snapshot in the same change.
 */
test("English copy is frozen to the verified phase-1 snapshot", () => {
    const snapshot = flatten(JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/i18n-en-phase1.snapshot.json"), "utf8")) as Tree);
    for (const [key, value] of snapshot) assert.equal(enFlat.get(key), value, `en.json ${key} changed`);
    const added = [...enFlat.keys()].filter((key) => !snapshot.has(key));
    assert.deepEqual(added, [], `new English keys: add them to tests/fixtures/i18n-en-phase1.snapshot.json`);
});

test("English copy moved to en.json is unchanged: navigation", () => {
    const sections = navSections({ isCompanyAdmin: true, isPlatformAdmin: true });
    for (const item of [...sections.flatMap((s) => s.items), ...MOBILE_TABS]) {
        assert.equal(enMessage(`nav.${item.id}`), item.name, `nav.${item.id}`);
        if (item.keywords) assert.equal(enMessage(`navKeywords.${item.id}`), item.keywords, `navKeywords.${item.id}`);
    }
    for (const section of sections) {
        if (section.title) assert.equal(enMessage(`navSections.${section.id}`), section.title, `navSections.${section.id}`);
    }
    // Every nav id has a label, so no item can render a raw key.
    assert.deepEqual(Object.keys(en.nav).sort(), [...new Set(sections.flatMap((s) => s.items.map((i) => i.id)))].sort());
});

test("English copy moved to en.json is unchanged: settings navigation", () => {
    for (const section of SETTINGS_SECTIONS) {
        assert.equal(enMessage(`settings.sections.${section.id}`), section.label);
        for (const item of section.items) {
            assert.equal(enMessage(`settings.items.${settingsItemKey(item.id)}`), item.label, item.id);
            assert.equal(enMessage(`settings.items.${settingsItemKey(item.id)}Description`), item.description, item.id);
        }
    }
});

test("English copy moved to en.json is unchanged: scene, inbox and shortcut labels", () => {
    for (const [english, key] of Object.entries(SCENE_CAPTION_KEYS)) assert.equal(enMessage(`scene.caption.${key}`), english);
    for (const { prefix, key, arg } of SCENE_CAPTION_PREFIXES) assert.equal(enMessage(`scene.caption.${key}`), `${prefix}{${arg}}`);
    for (const label of Object.values(BUCKET_LABEL)) assert.ok(label in SCENE_CAPTION_KEYS, `desk label "${label}" has no translation`);
    for (const [status, label] of Object.entries(STATUS_LABEL)) assert.equal(enMessage(`scene.status.${status}`), label);
    for (const [zone, meta] of Object.entries(ZONES)) assert.equal(enMessage(`scene.zones.${zone}`), meta.label);
    for (const [group, label] of Object.entries(ATTENTION_GROUP_LABEL)) assert.equal(enMessage(`inbox.groups.${group}`), label);
    for (const [key, chord] of Object.entries(GO_CHORDS)) assert.equal(enMessage(`shell.shortcuts.goTo.${key}`), `Go to ${chord.label}`);
    for (const [type, label] of Object.entries(SEARCH_TYPE_LABELS)) assert.equal(enMessage(`shell.palette.types.${type}`), label);
    // The inbox kind chips: KIND_STYLE keeps the English verb next to each icon.
    const source = readFileSync(path.join(ROOT, "src/components/team-dashboard/needs-attention.tsx"), "utf8");
    const verbs = [...source.matchAll(/^\s+(\w+): \{ icon: \w+, tile: "[^"]*", verb: "([^"]+)" \},$/gm)];
    assert.ok(verbs.length >= 13, "KIND_STYLE verbs found");
    for (const [, kind, verb] of verbs) assert.equal(enMessage(`scene.kind.${kind}`), verb, kind);
});
