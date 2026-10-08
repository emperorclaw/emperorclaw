import assert from "node:assert/strict";
import test from "node:test";
import {
    appearanceHash, appearancesEqual, deriveAppearance, hashString, legacyAvatarToAppearance,
    normalizeAppearance, resolveAppearance, resolveAvatarPhoto, seedFromLegacyUrl,
    agentAvatarEndpoint, CHARACTER_HUES, CHARACTER_ACCESSORIES, HAIR_COLORS, SKIN_TONES,
} from "../../src/lib/character/model";
import { figureNodes, renderAvatarSvg, serializeSvgNode, tileNode } from "../../src/lib/character/draw";
import { deriveBehavior } from "../../src/lib/team-scene";

test("appearance derivation is deterministic and stays in range", () => {
    const a = deriveAppearance("agent-123");
    const b = deriveAppearance("agent-123");
    assert.deepEqual(a, b);
    assert.ok(CHARACTER_HUES.includes(a.hue));
    assert.ok(CHARACTER_ACCESSORIES.includes(a.accessory));
    assert.ok(a.variant >= 0 && a.variant < 4);
    assert.ok(a.skin >= 0 && a.skin < SKIN_TONES.length);
    assert.ok(a.hair >= 0 && a.hair < HAIR_COLORS.length);
});

test("forced kind wins for people and robots", () => {
    for (let i = 0; i < 20; i++) {
        assert.equal(deriveAppearance(`x-${i}`, "human").kind, "human");
        assert.equal(deriveAppearance(`x-${i}`, "robot").kind, "robot");
    }
    const kinds = new Set(Array.from({ length: 40 }, (_, i) => deriveAppearance(`agent-${i}`).kind));
    assert.deepEqual([...kinds].sort(), ["human", "robot"]);
});

test("appearance hashes are stable and distinct", () => {
    const a = deriveAppearance("one");
    const b = deriveAppearance("two");
    assert.equal(appearanceHash(a), appearanceHash(deriveAppearance("one")));
    assert.notEqual(appearanceHash(a), appearanceHash(b));
    assert.equal(appearancesEqual(a, deriveAppearance("one")), true);
    assert.equal(hashString("abc"), hashString("abc"));
});

test("normalizeAppearance accepts valid input and rejects junk", () => {
    const valid = {
        version: 1, kind: "robot", seed: "seed-1", hue: 200, variant: 2, skin: 3, hair: 4, accessory: "glasses",
    };
    const normalized = normalizeAppearance(valid);
    assert.ok(normalized);
    assert.equal(normalized?.hue, 200);
    assert.equal(normalized?.accessory, "glasses");

    assert.equal(normalizeAppearance(null), null);
    assert.equal(normalizeAppearance("nope"), null);
    assert.equal(normalizeAppearance({ ...valid, kind: "alien" }), null);
    assert.equal(normalizeAppearance({ ...valid, hue: 400 }), null);
    assert.equal(normalizeAppearance({ ...valid, variant: 9 }), null);
    assert.equal(normalizeAppearance({ ...valid, accessory: "crown" }), null);
    assert.equal(normalizeAppearance({ ...valid, seed: "" }), null);
});

test("legacy DiceBear URLs map their seed onto an appearance", () => {
    assert.equal(seedFromLegacyUrl("https://example.com/a.png"), null);
    assert.equal(seedFromLegacyUrl(null), null);

    const url = "https://api.dicebear.com/9.x/pixel-art/svg?seed=Growth%20Bot";
    assert.equal(seedFromLegacyUrl(url), "Growth Bot");
    const appearance = legacyAvatarToAppearance(url);
    assert.ok(appearance);
    assert.equal(appearance?.seed, "Growth Bot");
    assert.deepEqual(appearance, deriveAppearance("Growth Bot"));
    // A custom https photo is not touched.
    assert.equal(legacyAvatarToAppearance("https://cdn.example.com/me.png"), null);
});

test("resolveAppearance prefers an override, then a legacy seed, then the id", () => {
    const override = deriveAppearance("override-seed", "human");
    assert.deepEqual(resolveAppearance({ id: "a1", avatarAppearance: override }), override);
    assert.equal(resolveAppearance({ id: "a1", avatarUrl: "https://api.dicebear.com/9.x/bottts/svg?seed=Legacy" }).seed, "Legacy");
    assert.equal(resolveAppearance({ id: "a1" }).seed, "a1");
    // A photo is not a drawn appearance; the drawing still derives from the id.
    assert.equal(resolveAppearance({ id: "a1", avatarUrl: "https://cdn.example.com/me.png" }).seed, "a1");
});

test("resolveAvatarPhoto retires DiceBear URLs but keeps uploaded photos", () => {
    assert.equal(resolveAvatarPhoto({ avatarUrl: "https://cdn.example.com/me.png" }), "https://cdn.example.com/me.png");
    assert.equal(resolveAvatarPhoto({ avatarUrl: "https://api.dicebear.com/9.x/pixel-art/svg?seed=x" }), null);
    assert.equal(resolveAvatarPhoto({ avatarUrl: null }), null);
    assert.equal(agentAvatarEndpoint("abc"), "/api/avatars/abc");
    assert.equal(agentAvatarEndpoint("abc", 64), "/api/avatars/abc?size=64");
});

test("activity derivation follows status and live copy", () => {
    const attn = (kind: "approval" | "incident" | "message" | "agent") => ({ id: `x:${kind}`, kind, title: "t", memberKey: "agent:a1", memberName: null, area: null, at: "2026-10-07T10:00:00.000Z", actionLabel: "Go", href: "/" });
    const kind = (input: Parameters<typeof deriveBehavior>[0]) => deriveBehavior({ memberKey: "agent:a1", taskType: null, idleRoutine: null, ...input }).kind;
    assert.equal(kind({ status: "offline", activity: "x" }), "offline");
    assert.equal(kind({ status: "blocked", activity: "x", attention: attn("incident") }), "blocked");
    assert.equal(kind({ status: "blocked", activity: "x", attention: attn("approval") }), "waiting");
    assert.equal(kind({ status: "blocked", activity: "x", attention: attn("message") }), "waiting");
    assert.equal(kind({ status: "waiting", activity: "x" }), "waiting");
    assert.equal(kind({ status: "idle", activity: "x", idleRoutine: "nap" }), "nap");
    assert.equal(kind({ status: "idle", activity: "x", idleRoutine: "coffee" }), "coffee");
    assert.equal(kind({ status: "working", activity: "Writing article" }), "writing");
    assert.equal(kind({ status: "working", activity: "Fixing login bug" }), "typing");
    assert.equal(kind({ status: "working", activity: "Reviewing changes" }), "reviewing");
    assert.equal(kind({ status: "working", activity: "Researching leads" }), "thinking");
    assert.equal(kind({ status: "working", activity: "Presenting roadmap" }), "presenting");
    assert.equal(kind({ status: "working", activity: "whatever", talking: true }), "talking");
    assert.equal(kind({ status: "working", activity: "whatever", justDone: true }), "celebrate");
});

test("the SVG renderer emits well-formed, sized output", () => {
    const appearance = deriveAppearance("render-me", "robot");
    const svg = renderAvatarSvg(appearance, 64);
    assert.ok(svg.startsWith("<svg "));
    assert.ok(svg.endsWith("</svg>"));
    assert.match(svg, /viewBox="-31 -94 62 62"/);
    assert.match(svg, /width="64"/);
    assert.ok(!/NaN|undefined/.test(svg));
    // Standalone SVG served to <img>/external clients needs the namespace and spec attribute names.
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /stop-color="/);
    assert.match(svg, /stroke-width="/);
    assert.ok(!/stopColor|strokeWidth|strokeLinecap/.test(svg), "no React-style camelCase attributes");

    const node = tileNode(appearance, { size: 40, idPrefix: "t1", label: "Robo" });
    const serialized = serializeSvgNode(node);
    assert.match(serialized, /aria-label="Robo"/);
    assert.match(serialized, /<linearGradient/);
});

test("the auth middleware exempts /api/avatars/ but keeps other agent APIs protected", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(__dirname, "../../src/proxy.ts"), "utf8");
    const matcher = JSON.parse(source.match(/matcher:\s*\[(".*")\]/)![1]) as string;
    const protectedPath = new RegExp(`^${matcher}$`);
    assert.equal(protectedPath.test("/api/avatars/0b6f9c1e-2f4a-4b8e-9a51-3c2d1e0f9a7b"), false, "avatars are public");
    assert.equal(protectedPath.test("/api/avatarsX"), true, "look-alike stays protected");
    assert.equal(protectedPath.test("/api/agents/0b6f9c1e-2f4a-4b8e-9a51-3c2d1e0f9a7b"), true);
});

test("expressions change only the face: sleepy closes the eyes, worried adds brows, scanning wraps the eyes", () => {
    const appearance = deriveAppearance("face-test", "human");
    const face = (expression: "neutral" | "happy" | "focused" | "worried" | "sleepy" | "scanning") =>
        serializeSvgNode({ tag: "g", children: figureNodes(appearance, { idPrefix: "x", expression }) });
    const neutral = face("neutral");
    assert.match(neutral, /class="office-eyes"/);
    assert.ok(!face("sleepy").includes('class="office-eyes"'), "closed eyes don't blink");
    assert.ok(face("worried").length > neutral.length, "worried adds brows");
    assert.match(face("scanning"), /class="office-scan"/);
    assert.ok(!face("happy").includes("<ellipse cx=\"-6.6\""), "happy eyes are arcs");
});
