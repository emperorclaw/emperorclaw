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
import { createTranslator } from "use-intl/core";
import { COMPANY_TEMPLATES, MODULES } from "../../src/lib/modules";
import { BOARD_COLUMN_LABEL, CARD_SIGNAL_LABEL, REVIEW_BUCKET_LABEL, priorityLevel } from "../../src/lib/project-board-model";
import { ACTION_CATALOG } from "../../src/lib/action-policy";
import { TEAM_TEMPLATES } from "../../src/lib/onboarding-shared";
import { MEMORY_KIND_LABELS } from "../../src/lib/agent-memory";
import { RUN_OUTCOME_LABEL, taskStateLabel } from "../../src/lib/task-story";
import { RESOURCE_ROLE_LABELS } from "../../src/lib/resource-roles";
import { triggerKindLabel } from "../../src/lib/run-ledger-copy";
import { agentAccessSummary } from "../../src/lib/agent-access";
import { refreshCadenceText } from "../../src/lib/view-access";
import { bridgeBadgeCopy } from "../../src/lib/live-activity";
import { stallLabel } from "../../src/lib/stall-signal";
import { BUSINESS_TYPES, MAX_WIZARD_AGENTS, TEAM_PLAN_PROBLEM_TEXT } from "../../src/lib/onboarding-shared";
import { COST_TAB_LABELS, RANGE_PRESET_LABELS } from "../../src/lib/costs";
import { ARTIFACT_CLASS_OPTIONS, ARTIFACT_IMPORTANCE_OPTIONS } from "../../src/lib/artifact-taxonomy";
import { hermesImageProgressLabel, hermesImageProgressMessage } from "../../src/components/hermes-image-progress";

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
    // Standard compounds that contain a banned word but mean something else.
    const allowed = ["反向代理" /* reverse proxy */, "代理机构" /* agency */];
    for (const [key, value] of zhFlat) {
        const checked = allowed.reduce((text, word) => text.replaceAll(word, ""), value);
        for (const [word, use] of Object.entries(banned)) {
            assert.ok(!checked.includes(word), `zh-CN ${key} uses "${word}"; use ${use}`);
        }
        // Full-width punctuation in Chinese sentences: no ASCII "," ";" "?" "!" after a CJK character.
        assert.ok(!/[一-鿿][,;?!]/.test(value), `zh-CN ${key} uses ASCII punctuation after Chinese text: ${value}`);
    }
});

/**
 * Every English message as verified against the HEAD source literals it
 * replaced when it moved into en.json: phase 1 (shell, Home, Inbox, errors,
 * time, …), phase 2 (agents, projects and tasks, views, settings, runtime
 * hosts, access) and phase 3 (sign-in and sign-up, onboarding, the remaining
 * app pages, chat and shared components) and phase 3b (server-built copy the UI renders from codes:
 * failures, inbox entries, task story, run timeline, delivery, role templates,
 * providers, hire reasons, common API errors, emails). Changing English copy is deliberate: update the snapshot of
 * its phase in the same change; new keys go in the current phase's snapshot.
 */
const SNAPSHOTS = ["tests/fixtures/i18n-en-phase1.snapshot.json", "tests/fixtures/i18n-en-phase2.snapshot.json", "tests/fixtures/i18n-en-phase3.snapshot.json", "tests/fixtures/i18n-en-phase3b.snapshot.json"];

test("English copy is frozen to the verified phase snapshots", () => {
    const snapshot = new Map<string, string>();
    for (const file of SNAPSHOTS) {
        for (const [key, value] of flatten(JSON.parse(readFileSync(path.join(ROOT, file), "utf8")) as Tree)) {
            assert.ok(!snapshot.has(key), `${key} is in more than one snapshot`);
            snapshot.set(key, value);
        }
    }
    for (const [key, value] of snapshot) assert.equal(enFlat.get(key), value, `en.json ${key} changed`);
    const added = [...enFlat.keys()].filter((key) => !snapshot.has(key));
    assert.deepEqual(added, [], `new English keys: add them to ${SNAPSHOTS[SNAPSHOTS.length - 1]}`);
});

/** Renders an en.json message the way next-intl does (same ICU formatter). */
const translate = createTranslator({ locale: "en", messages: en as never });
const render = (key: string, values?: Record<string, string | number>) => (translate as unknown as (key: string, values?: Record<string, string | number>) => string)(key, values);

test("English copy moved to en.json is unchanged: phase-2 label maps", () => {
    for (const m of MODULES) {
        assert.equal(enMessage(`settings.modules.items.${m.key}.label`), m.label, m.key);
        assert.equal(enMessage(`settings.modules.items.${m.key}.description`), m.description, m.key);
    }
    for (const template of COMPANY_TEMPLATES) {
        assert.equal(enMessage(`settings.modules.templates.${template.id}.label`), template.label, template.id);
        assert.equal(enMessage(`settings.modules.templates.${template.id}.description`), template.description, template.id);
    }
    for (const [key, label] of Object.entries(BOARD_COLUMN_LABEL)) assert.equal(enMessage(`tasks.columns.${key}`), label, key);
    for (const [key, label] of Object.entries(CARD_SIGNAL_LABEL)) assert.equal(enMessage(`tasks.signals.${key}`), label, key);
    for (const [key, label] of Object.entries(REVIEW_BUCKET_LABEL)) assert.equal(enMessage(`tasks.reviewBuckets.${key}`), label, key);
    for (const value of [25, 50, 75, 100]) {
        const level = priorityLevel(value)!;
        assert.equal(enMessage(`tasks.priority.${level.tone}`), level.label, String(value));
    }
    for (const state of ["inbox", "queued", "in_progress", "review", "blocked", "done", "failed", "dead_letter"]) {
        assert.equal(enMessage(`tasks.states.${state}`), taskStateLabel(state), state);
    }
    for (const [key, label] of Object.entries(RUN_OUTCOME_LABEL)) assert.equal(enMessage(`tasks.timeline.outcomes.${key}`), label, key);
    for (const entry of ACTION_CATALOG) assert.equal(enMessage(`agents.actions.catalog.${entry.key}`), entry.label, entry.key);
    for (const team of TEAM_TEMPLATES) {
        assert.equal(enMessage(`agents.easySetup.teams.${team.id}.label`), team.label, team.id);
        assert.equal(enMessage(`agents.easySetup.teams.${team.id}.hint`), team.hint, team.id);
    }
    for (const [key, label] of Object.entries(MEMORY_KIND_LABELS)) assert.equal(enMessage(`agents.memory.kinds.${key}`), label, key);
    for (const [key, label] of Object.entries(RESOURCE_ROLE_LABELS)) assert.equal(enMessage(`access.roles.${key}`), label, key);
    for (const kind of ["message", "task", "objective", "other"]) assert.equal(enMessage(`agents.runs.triggers.${kind}`), triggerKindLabel(kind), kind);
});

test("English copy moved to en.json is unchanged: phase-2 formatted copy", () => {
    // Who can use an agent (lib/agent-access.ts agentAccessSummary).
    assert.equal(render("access.agent.summaryEveryone"), agentAccessSummary({ access: "everyone", ownerName: "Ana", peopleCount: 0 }));
    assert.equal(render("access.agent.summaryOnly", { owner: "Ana" }), agentAccessSummary({ access: "owner", ownerName: "Ana", peopleCount: 0 }));
    for (const count of [1, 3]) {
        assert.equal(render("access.agent.summaryPeople", { owner: "Ana", count }), agentAccessSummary({ access: "people", ownerName: "Ana", peopleCount: count }));
    }
    // A view's refresh cadence (lib/view-access.ts refreshCadenceText).
    const cadence = (minutes: number) => minutes === 60 ? render("views.cadence.hourly") : minutes === 1440 ? render("views.cadence.daily")
        : minutes === 10080 ? render("views.cadence.weekly") : minutes < 60 ? render("views.cadence.everyMinutes", { count: minutes })
            : minutes % 1440 === 0 ? render("views.cadence.everyDays", { count: minutes / 1440 })
                : minutes % 60 === 0 ? render("views.cadence.everyHours", { count: minutes / 60 }) : render("views.cadence.everyMinutes", { count: minutes });
    for (const minutes of [15, 60, 120, 1440, 2880, 10080, 90]) assert.equal(cadence(minutes), refreshCadenceText(minutes), String(minutes));
    // The bridge badge (lib/live-activity.ts bridgeBadgeCopy).
    for (const managed of [true, false]) {
        const update = render(managed ? "agents.bridge.updateManaged" : "agents.bridge.updateSelf");
        assert.equal(render("agents.bridge.currentVersion", { version: "0.22.0" }), bridgeBadgeCopy("current", "0.22.0", managed).label);
        assert.equal(render("agents.bridge.currentHint"), bridgeBadgeCopy("current", "0.22.0", managed).hint);
        assert.equal(render("agents.bridge.updateAvailableHint", { version: "0.9.0", update }), bridgeBadgeCopy("update-available", "0.9.0", managed).hint);
        assert.equal(render("agents.bridge.unsupportedHint", { version: "0.5.0", update }), bridgeBadgeCopy("unsupported", "0.5.0", managed).hint);
        assert.equal(render("agents.bridge.legacyHint", { update }), bridgeBadgeCopy("legacy", null, managed).hint);
    }
    // A stalled run (lib/stall-signal.ts stallLabel).
    assert.equal(render("tasks.live.noProgressFor", { idle: render("tasks.live.idleMinutes", { count: 14 }) }), stallLabel({ stalled: true, idleMs: 14 * 60_000 }));
    assert.equal(render("tasks.live.lastUsefulAction", { idle: render("tasks.live.idleSeconds", { count: 40 }) }), stallLabel({ stalled: false, idleMs: 40_000 }));
    assert.equal(render("tasks.live.noProgressFor", { idle: render("tasks.live.idleHours", { hours: 1, minutes: "05" }) }), stallLabel({ stalled: true, idleMs: 65 * 60_000 }));
});

test("English copy moved to en.json is unchanged: phase-3 label maps", () => {
    for (const type of BUSINESS_TYPES) {
        assert.equal(enMessage(`onboarding.businessTypes.${type.id}.label`), type.label, type.id);
        assert.equal(enMessage(`onboarding.businessTypes.${type.id}.hint`), type.hint, type.id);
    }
    for (const [kind, text] of Object.entries(TEAM_PLAN_PROBLEM_TEXT)) {
        assert.equal(render(`onboarding.wizard.planProblems.${kind}`, { max: MAX_WIZARD_AGENTS }), text, kind);
    }
    for (const [tab, label] of Object.entries(COST_TAB_LABELS)) assert.equal(enMessage(`costs.tabs.${tab}`), label, tab);
    for (const [preset, label] of Object.entries(RANGE_PRESET_LABELS)) assert.equal(enMessage(`costs.ranges.${preset}`), label, preset);
    for (const option of ARTIFACT_CLASS_OPTIONS) {
        assert.equal(enMessage(`artifacts.classes.${option.value}.label`), option.label, option.value);
        assert.equal(enMessage(`artifacts.classes.${option.value}.description`), option.description, option.value);
    }
    for (const option of ARTIFACT_IMPORTANCE_OPTIONS) {
        assert.equal(enMessage(`artifacts.importance.${option.value}.label`), option.label, option.value);
        assert.equal(enMessage(`artifacts.importance.${option.value}.description`), option.description, option.value);
    }
    // The one-time runtime download line (components/hermes-image-progress.tsx).
    for (const state of [{}, { downloadedBytes: 600_000_000 }, { downloadedBytes: 250_000_000, totalBytes: 1_460_000_000 }, { phase: "extracting" as const }, { phase: "extracting" as const, extractedBytes: 700_000_000, totalBytes: 1_460_000_000 }]) {
        const message = hermesImageProgressMessage(state);
        assert.equal(render(`hermesImage.${message.key}`, message.values), hermesImageProgressLabel(state), JSON.stringify(state));
    }
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
