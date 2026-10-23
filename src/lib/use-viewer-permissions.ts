"use client";

import { useEffect, useState } from "react";

/**
 * What the signed-in person may do, for hiding or disabling controls. The
 * server is the authority (every route re-checks the role and scope from the
 * DB); this only keeps the UI from offering actions that would be refused.
 */
export type ViewerPermissions = {
    loaded: boolean;
    role: string | null;
    /** member and up: create, edit, delete company data. */
    canWrite: boolean;
    /** owner/admin: settings, tokens, members, agent data scopes, agent memory. */
    canAdmin: boolean;
};

const UNKNOWN: ViewerPermissions = { loaded: false, role: null, canWrite: false, canAdmin: false };

let pending: Promise<ViewerPermissions> | null = null;

function loadPermissions(): Promise<ViewerPermissions> {
    if (!pending) {
        pending = fetch("/api/user/profile", { cache: "no-store" })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => ({
                loaded: true,
                role: typeof data?.role === "string" ? data.role : null,
                canWrite: data?.canWrite === true,
                canAdmin: data?.canAdmin === true,
            }))
            .catch(() => ({ ...UNKNOWN, loaded: true }));
        // Re-read on the next mount after a while: a role change applies without a reload.
        setTimeout(() => { pending = null; }, 30_000);
    }
    return pending;
}

export function useViewerPermissions(): ViewerPermissions {
    const [permissions, setPermissions] = useState<ViewerPermissions>(UNKNOWN);
    useEffect(() => {
        let alive = true;
        void loadPermissions().then((value) => { if (alive) setPermissions(value); });
        return () => { alive = false; };
    }, []);
    return permissions;
}
