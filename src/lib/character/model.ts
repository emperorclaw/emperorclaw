/**
 * Pure appearance model for Emperor Claw's own characters. One deterministic
 * look is derived from an agent id, and agents may override it. No React, no
 * database, no external service — everything here is unit-tested and shared by
 * the dashboard scene, the in-app avatar tiles and the public SVG endpoint.
 */

export type CharacterKind = "robot" | "human";
export type CharacterAccessory = "none" | "glasses" | "headset" | "cap" | "bow";

/** Stable schema for the `agents.avatar_appearance` jsonb column. */
export interface CharacterAppearance {
    version: 1;
    kind: CharacterKind;
    seed: string;
    /** Primary hue in degrees, 0–359. Drives body/clothes and the tile glow. */
    hue: number;
    /** Silhouette roll: head shape and small proportions. */
    variant: number;
    /** Index into SKIN_TONES (humans). */
    skin: number;
    /** Index into HAIR_COLORS + style roll (humans). */
    hair: number;
    accessory: CharacterAccessory;
}

export const CHARACTER_APPEARANCE_VERSION = 1 as const;

/** Restrained, B2B-friendly palette used to tint characters. */
export const CHARACTER_HUES = [190, 205, 265, 150, 38, 340, 210, 95, 20, 300, 170, 250];
export const SKIN_TONES = ["#f7d7bd", "#ecc19c", "#d8a074", "#b97e52", "#8a5738", "#5f3a25"];
export const HAIR_COLORS = ["#241a15", "#4b2f1e", "#8a5a2b", "#d9a441", "#e9d29a", "#6f2f2f", "#334155", "#9b8aa6"];
export const CHARACTER_ACCESSORIES: CharacterAccessory[] = ["none", "glasses", "headset", "cap", "bow", "none", "none"];
export const CHARACTER_VARIANTS = 4;
export const CHARACTER_HAIR_STYLES = 6;

const KINDS: CharacterKind[] = ["robot", "human"];
const ACCESSORY_SET = new Set<string>(["none", "glasses", "headset", "cap", "bow"]);

/** FNV-1a — the same hash the office layout uses, so looks are stable. */
export function hashString(input: string): number {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function pick(hash: number, shift: number, mod: number): number {
    return (hash >>> shift) % mod;
}

/** A deterministic appearance for a seed; kind can be forced (people stay people). */
export function deriveAppearance(seed: string, kind?: CharacterKind): CharacterAppearance {
    const key = (seed || "agent").trim() || "agent";
    const h = hashString(key);
    const resolvedKind: CharacterKind = kind ?? (h % 3 === 0 ? "human" : "robot");
    return {
        version: CHARACTER_APPEARANCE_VERSION,
        kind: resolvedKind,
        seed: key,
        hue: CHARACTER_HUES[pick(h, 0, CHARACTER_HUES.length)],
        variant: pick(h, 3, CHARACTER_VARIANTS),
        skin: pick(h, 6, SKIN_TONES.length),
        hair: pick(h, 9, CHARACTER_HAIR_STYLES),
        accessory: CHARACTER_ACCESSORIES[pick(h, 12, CHARACTER_ACCESSORIES.length)],
    };
}

function intInRange(value: unknown, min: number, max: number): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const rounded = Math.round(value);
    return rounded >= min && rounded <= max ? rounded : null;
}

/**
 * Strictly validate and normalize untrusted JSON into an appearance, or null.
 * Unknown/extra fields are dropped; out-of-range numbers are rejected (never
 * silently clamped) so bad API input fails loudly at the edge.
 */
export function normalizeAppearance(value: unknown): CharacterAppearance | null {
    if (!value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    if (!KINDS.includes(v.kind as CharacterKind)) return null;
    const seed = typeof v.seed === "string" ? v.seed.trim() : "";
    if (!seed || seed.length > 160) return null;
    const hue = intInRange(v.hue, 0, 359);
    const variant = intInRange(v.variant, 0, CHARACTER_VARIANTS - 1);
    const skin = intInRange(v.skin, 0, SKIN_TONES.length - 1);
    const hair = intInRange(v.hair, 0, CHARACTER_HAIR_STYLES - 1);
    if (hue === null || variant === null || skin === null || hair === null) return null;
    if (typeof v.accessory !== "string" || !ACCESSORY_SET.has(v.accessory)) return null;
    return {
        version: CHARACTER_APPEARANCE_VERSION,
        kind: v.kind as CharacterKind,
        seed,
        hue,
        variant,
        skin,
        hair,
        accessory: v.accessory as CharacterAccessory,
    };
}

/** Canonical, key-ordered JSON so equal appearances hash and compare equal. */
export function appearanceKey(a: CharacterAppearance): string {
    return JSON.stringify([a.version, a.kind, a.seed, a.hue, a.variant, a.skin, a.hair, a.accessory]);
}

/** Short stable hash used for ETags and cache-busting. */
export function appearanceHash(a: CharacterAppearance): string {
    return hashString(appearanceKey(a)).toString(16).padStart(8, "0");
}

export function appearancesEqual(a: CharacterAppearance, b: CharacterAppearance): boolean {
    return appearanceKey(a) === appearanceKey(b);
}

const DICEBEAR = /^https:\/\/api\.dicebear\.com\/[^/]+\/([a-z-]+)\/svg\?seed=([^&]*)/i;

/** The seed inside a legacy DiceBear URL, or null for any other picture. */
export function seedFromLegacyUrl(url: string | null | undefined): string | null {
    const match = url ? DICEBEAR.exec(url.trim()) : null;
    if (!match) return null;
    try {
        const seed = decodeURIComponent(match[2]);
        return seed.trim() ? seed : null;
    } catch {
        return match[2].trim() ? match[2] : null;
    }
}

/**
 * Map a stored value (legacy DiceBear URL or uploaded https photo) onto the
 * new model. Returns the appearance derived from the DiceBear seed and a null
 * avatarUrl (so the legacy URL is retired), or leaves custom photos untouched.
 */
export function legacyAvatarToAppearance(url: string | null | undefined, kind?: CharacterKind): CharacterAppearance | null {
    const seed = seedFromLegacyUrl(url);
    return seed ? deriveAppearance(seed, kind) : null;
}

export interface AvatarSource {
    id: string;
    avatarUrl?: string | null;
    avatarAppearance?: unknown;
    kind?: CharacterKind;
}

/**
 * The appearance to draw for an agent: an explicit valid override, else the
 * legacy DiceBear seed, else a look derived from the agent id.
 */
export function resolveAppearance(agent: AvatarSource): CharacterAppearance {
    const override = normalizeAppearance(agent.avatarAppearance);
    if (override) return override;
    const legacy = legacyAvatarToAppearance(agent.avatarUrl, agent.kind);
    if (legacy) return legacy;
    return deriveAppearance(agent.id, agent.kind);
}

/** The uploaded photo to show instead of a drawn character, if any. */
export function resolveAvatarPhoto(agent: { avatarUrl?: string | null }): string | null {
    return seedFromLegacyUrl(agent.avatarUrl) ? null : agent.avatarUrl ?? null;
}

/** Relative URL of the public avatar drawing for an agent. */
export function agentAvatarEndpoint(agentId: string, size?: number): string {
    const base = `/api/avatars/${encodeURIComponent(agentId)}`;
    return typeof size === "number" ? `${base}?size=${Math.round(size)}` : base;
}

/** Absolute URL when the deployment exposes a public base URL, else relative. */
export function publicAppBaseUrl(): string | null {
    const configured = process.env.APP_URL || process.env.NEXTAUTH_URL || process.env.EMPEROR_PUBLIC_URL;
    if (configured && configured.trim()) return configured.trim().replace(/\/+$/, "");
    return null;
}

/** What an agent shows to external consumers: its photo, else our endpoint. */
export function agentAvatarUrl(agent: AvatarSource): string {
    const photo = resolveAvatarPhoto(agent);
    if (photo) return photo;
    const base = publicAppBaseUrl();
    return base ? `${base}${agentAvatarEndpoint(agent.id)}` : agentAvatarEndpoint(agent.id);
}
