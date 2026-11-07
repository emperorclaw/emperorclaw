"use client";

import { useTheme } from "next-themes";
import { IconSun, IconMoon } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslations } from "next-intl";

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => unknown };

/**
 * Cross-fade light and dark through the View Transitions API where the
 * browser has it (the 240 ms fade is in globals.css); a plain switch
 * otherwise or when the person prefers reduced motion. The class is set
 * synchronously inside the transition so the new snapshot is the new theme.
 */
function switchTheme(next: "light" | "dark", setTheme: (theme: string) => void) {
  const doc = document as ViewTransitionDocument;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!doc.startViewTransition || reduced) {
    setTheme(next);
    return;
  }
  doc.startViewTransition(() => {
    flushSync(() => setTheme(next));
    document.documentElement.classList.toggle("dark", next === "dark");
    document.documentElement.classList.toggle("light", next === "light");
    document.documentElement.style.colorScheme = next;
  });
}

export function ThemeToggle({ collapsed = false, mini = false }: { collapsed?: boolean; mini?: boolean }) {
  const t = useTranslations("theme");
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // The theme is only known on the client: render the placeholder until mounted.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <button
        type="button"
        aria-label={t("toggle")}
        className={mini ? "flex h-5 w-5 items-center justify-center text-zinc-400" : "flex w-full cursor-pointer items-center justify-center rounded-xl px-2 py-2.5 text-sm font-medium text-zinc-400"}
      >
        <IconSun className={mini ? "h-3.5 w-3.5" : "h-4 w-4"} />
      </button>
    );
  }

  const isDark = resolvedTheme === "dark";

  if (mini) {
    return (
      <button
        type="button"
        onClick={() => switchTheme(isDark ? "light" : "dark", setTheme)}
        aria-label={isDark ? t("switchToLight") : t("switchToDark")}
        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800/60 dark:hover:bg-white/[0.045] hover:text-zinc-100"
      >
        {isDark ? <IconSun className="h-3.5 w-3.5" /> : <IconMoon className="h-3.5 w-3.5" />}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => switchTheme(isDark ? "light" : "dark", setTheme)}
      aria-label={isDark ? t("switchToLight") : t("switchToDark")}
      className="flex w-full cursor-pointer items-center rounded-xl text-sm font-medium text-zinc-400 transition-all duration-200 hover:bg-zinc-800/60 dark:hover:bg-white/[0.045] hover:text-zinc-100"
      style={collapsed ? { justifyContent: "center", padding: "0.625rem 0.5rem" } : { gap: "0.75rem", padding: "0.625rem 0.75rem" }}
    >
      {isDark ? <IconSun className="h-4 w-4" /> : <IconMoon className="h-4 w-4" />}
      <span className={collapsed ? "hidden" : "md:inline"}>{isDark ? t("lightMode") : t("darkMode")}</span>
    </button>
  );
}
