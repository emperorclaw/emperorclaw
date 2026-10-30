"use client";

import { useTheme } from "next-themes";
import { IconSun, IconMoon } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

export function ThemeToggle({ collapsed = false, mini = false }: { collapsed?: boolean; mini?: boolean }) {
  const t = useTranslations("theme");
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
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
        onClick={() => setTheme(isDark ? "light" : "dark")}
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
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? t("switchToLight") : t("switchToDark")}
      className="flex w-full cursor-pointer items-center rounded-xl text-sm font-medium text-zinc-400 transition-all duration-200 hover:bg-zinc-800/60 dark:hover:bg-white/[0.045] hover:text-zinc-100"
      style={collapsed ? { justifyContent: "center", padding: "0.625rem 0.5rem" } : { gap: "0.75rem", padding: "0.625rem 0.75rem" }}
    >
      {isDark ? <IconSun className="h-4 w-4" /> : <IconMoon className="h-4 w-4" />}
      <span className={collapsed ? "hidden" : "md:inline"}>{isDark ? t("lightMode") : t("darkMode")}</span>
    </button>
  );
}
