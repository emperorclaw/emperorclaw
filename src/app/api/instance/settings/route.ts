import { NextRequest, NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/roles";
import { getInstanceSettings, setInstanceSettingsBatch, isSelfHosted } from "@/lib/instance";

// ── GET /api/instance/settings — Retrieve all instance settings (any authenticated role) ──

export async function GET(_req: NextRequest) {
    try {
        // Any authenticated user can read settings (but must be logged in)
        const session = await requireRole("viewer")().catch(() => null);
        if (!session) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        if (!isSelfHosted()) {
            return NextResponse.json(
                { error: "Instance settings are only available in self-hosted deployments." },
                { status: 403 }
            );
        }

        const settings = await getInstanceSettings();

        // Filter out sensitive keys from the response (e.g., smtp_password)
        const safeSettings: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(settings)) {
            if (key === "smtp_password") {
                safeSettings[key] = "********"; // Never expose the actual SMTP password
            } else {
                safeSettings[key] = value;
            }
        }

        return NextResponse.json({ settings: safeSettings }, { status: 200 });
    } catch (err) {
        console.error("Get instance settings error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

// ── PUT /api/instance/settings — Update instance settings (instance_admin only) ──

export async function PUT(req: NextRequest) {
    try {
        if (!isSelfHosted()) {
            return NextResponse.json(
                { error: "Instance settings are only available in self-hosted deployments." },
                { status: 403 }
            );
        }

        const ctx = await requireRole("instance_admin")();

        const body = await req.json();
        const { settings } = body;

        if (!settings || typeof settings !== "object") {
            return NextResponse.json(
                { error: "Missing required field: settings (object)" },
                { status: 400 }
            );
        }

        // Validate known keys minimally
        const knownKeys = [
            "registration_mode",
            "instance_name",
            "smtp_host",
            "smtp_port",
            "smtp_user",
            "smtp_password",
            "smtp_from",
        ];

        const sanitizedSettings: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(settings)) {
            // Allow known keys + unknown keys (forward compat per FR-27)
            if (knownKeys.includes(key)) {
                // Validate registration_mode values
                if (key === "registration_mode" && !["invite-only", "open"].includes(String(value))) {
                    return NextResponse.json(
                        { error: "registration_mode must be 'invite-only' or 'open'" },
                        { status: 400 }
                    );
                }
                // Validate smtp_port is a number
                if (key === "smtp_port" && value !== null && value !== undefined && value !== "") {
                    const port = Number(value);
                    if (isNaN(port) || port < 1 || port > 65535) {
                        return NextResponse.json(
                            { error: "smtp_port must be a valid port number (1-65535)" },
                            { status: 400 }
                        );
                    }
                    sanitizedSettings[key] = port;
                    continue;
                }
            }
            sanitizedSettings[key] = value;
        }

        await setInstanceSettingsBatch(sanitizedSettings);

        // Return updated settings (minus smtp_password)
        const updated = await getInstanceSettings();
        const safeUpdated: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(updated)) {
            if (key === "smtp_password") {
                safeUpdated[key] = "********";
            } else {
                safeUpdated[key] = value;
            }
        }

        return NextResponse.json({ settings: safeUpdated }, { status: 200 });
    } catch (err) {
        if (err instanceof AuthError) {
            return NextResponse.json({ error: err.message }, { status: err.statusCode });
        }
        console.error("Update instance settings error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
