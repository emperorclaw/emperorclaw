"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";

const subscribeNever = () => () => {};

/**
 * True when the resolved theme is dark. For colours that cannot come from CSS
 * variables (SVG attributes, canvas drawing). Until hydration it returns
 * `fallback` (the app defaults to dark) so the server and first client render
 * match, then follows the real theme.
 */
export function useIsDarkTheme(fallback = true): boolean {
    const { resolvedTheme } = useTheme();
    const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);
    if (!mounted || !resolvedTheme) return fallback;
    return resolvedTheme === "dark";
}
