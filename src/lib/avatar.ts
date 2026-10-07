/**
 * Agent avatars are drawn by Emperor Claw itself (see src/lib/character).
 * `avatarUrl` is reserved for uploaded/custom https photos; everything else
 * resolves to the stable public endpoint.
 */

export {
    agentAvatarEndpoint,
    agentAvatarUrl,
    appearanceHash,
    deriveAppearance,
    legacyAvatarToAppearance,
    normalizeAppearance,
    publicAppBaseUrl,
    resolveAppearance,
    resolveAvatarPhoto,
    seedFromLegacyUrl,
    CHARACTER_ACCESSORIES,
    CHARACTER_HUES,
    CHARACTER_APPEARANCE_VERSION,
    HAIR_COLORS,
    SKIN_TONES,
    type CharacterAccessory,
    type CharacterAppearance,
    type CharacterKind,
} from "@/lib/character/model";

import { resolveAvatarPhoto, agentAvatarEndpoint } from "@/lib/character/model";

/**
 * The src to show for an agent tile in the app: its uploaded photo, else the
 * drawn character served by our own endpoint.
 */
export function agentAvatarSrc(agent: { id: string; avatarUrl?: string | null }): string {
    return resolveAvatarPhoto(agent) ?? agentAvatarEndpoint(agent.id);
}

/** Avatar URLs agents may store: any https image (your own photo). */
export function validAvatarUrl(value: unknown): string | null {
    if (typeof value !== "string" || value.length > 500) return null;
    try {
        const url = new URL(value.trim());
        return url.protocol === "https:" ? url.toString() : null;
    } catch {
        return null;
    }
}
