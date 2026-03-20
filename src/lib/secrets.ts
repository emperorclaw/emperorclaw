import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const KEY_VERSION = "v1";

function getMasterKey(): Buffer | null {
    const raw = process.env.EMPEROR_CLAW_MASTER_KEY;
    if (!raw) return null;

    const trimmed = raw.trim();
    if (!trimmed) return null;

    return createHash("sha256").update(trimmed).digest();
}

export function canManageSecrets() {
    return !!getMasterKey();
}

export function encryptSecretPayload(payload: unknown) {
    const key = getMasterKey();
    if (!key) return null;

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
        encryptedSecret: JSON.stringify({
            iv: iv.toString("base64"),
            tag: tag.toString("base64"),
            ciphertext: ciphertext.toString("base64"),
        }),
        keyVersion: KEY_VERSION,
    };
}

export function decryptSecretPayload(encryptedSecret: string) {
    const key = getMasterKey();
    if (!key) {
        throw new Error("EMPEROR_CLAW_MASTER_KEY is not configured");
    }

    const parsed = JSON.parse(encryptedSecret) as {
        iv: string;
        tag: string;
        ciphertext: string;
    };

    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));

    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(parsed.ciphertext, "base64")),
        decipher.final(),
    ]);

    return JSON.parse(plaintext.toString("utf8"));
}
