"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function AutoRefresh({ intervalMs = 5000 }: { intervalMs?: number }) {
    const router = useRouter();

    useEffect(() => {
        const refresh = () => {
            if (!document.hidden && navigator.onLine) router.refresh();
        };
        const interval = setInterval(refresh, intervalMs);
        document.addEventListener("visibilitychange", refresh);
        window.addEventListener("online", refresh);
        return () => {
            clearInterval(interval);
            document.removeEventListener("visibilitychange", refresh);
            window.removeEventListener("online", refresh);
        };
    }, [router, intervalMs]);

    return null;
}
