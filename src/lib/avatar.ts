/**
 * Agent avatars come from DiceBear (https://www.dicebear.com): a style plus a
 * seed gives a stable picture. Pixel art is the default; an agent can pick any
 * style below, and a new seed reshuffles the picture within a style.
 */
export const AVATAR_STYLES = [
    { id: "pixel-art", label: "Pixel art" },
    { id: "bottts", label: "Robots" },
    { id: "bottts-neutral", label: "Robot faces" },
    { id: "adventurer", label: "Adventurer" },
    { id: "avataaars", label: "Cartoon" },
    { id: "lorelei", label: "Line art" },
    { id: "notionists", label: "Sketch" },
    { id: "open-peeps", label: "Hand-drawn" },
    { id: "personas", label: "Personas" },
    { id: "fun-emoji", label: "Emoji" },
    { id: "thumbs", label: "Thumbs" },
    { id: "shapes", label: "Shapes" },
] as const;

export type AvatarStyle = typeof AVATAR_STYLES[number]["id"];
export const DEFAULT_AVATAR_STYLE: AvatarStyle = "pixel-art";

const DICEBEAR = /^https:\/\/api\.dicebear\.com\/9\.x\/([a-z-]+)\/svg\?seed=([^&]*)/;

export function isAvatarStyle(value: unknown): value is AvatarStyle {
    return AVATAR_STYLES.some((s) => s.id === value);
}

export function dicebearUrl(style: AvatarStyle, seed: string): string {
    return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}`;
}

/** The style and seed of a DiceBear avatar URL, or null for any other picture. */
export function parseDicebearUrl(url: string | null | undefined): { style: string; seed: string } | null {
    const match = url ? DICEBEAR.exec(url) : null;
    if (!match) return null;
    try {
        return { style: match[1], seed: decodeURIComponent(match[2]) };
    } catch {
        return { style: match[1], seed: match[2] };
    }
}

/** What an agent shows: its own picture, or the default style seeded by its id. */
export function agentAvatarUrl(agent: { id: string; avatarUrl?: string | null }): string {
    return agent.avatarUrl || dicebearUrl(DEFAULT_AVATAR_STYLE, agent.id);
}

/** Avatar URLs agents may store: any https image (DiceBear or your own). */
export function validAvatarUrl(value: unknown): string | null {
    if (typeof value !== "string" || value.length > 500) return null;
    try {
        const url = new URL(value.trim());
        return url.protocol === "https:" ? url.toString() : null;
    } catch {
        return null;
    }
}
