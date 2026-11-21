/** Mobile v1 is deliberately independent of the firmware/MCP contracts. */
export const MOBILE_API_VERSION = 1;
export const MOBILE_CALLBACK = "com.emperorclaw.app://oauth/callback";
export const MOBILE_ACCESS_SECONDS = 15 * 60;
export const MOBILE_SESSION_SECONDS = 30 * 24 * 60 * 60;

export function validMobileAuthorization(input: { challenge: string; state: string; deviceName: string }) {
    return /^[A-Za-z0-9_-]{43}$/.test(input.challenge)
        && /^[A-Za-z0-9_-]{32,128}$/.test(input.state)
        && input.deviceName.trim().length > 0 && input.deviceName.length <= 80;
}

export function validMobileVerifier(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}
