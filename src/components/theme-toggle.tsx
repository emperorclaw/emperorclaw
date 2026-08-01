"use client";

import { useTheme } from "next-themes";
import { IconSun, IconMoon } from "@tabler/icons-react";
import { useEffect, useState } from "react";

export function ThemeToggle({ collapsed = false }: { collapsed?: boolean }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <button
        type="button"
        aria-label="Toggle theme"
        className="flex w-full cursor-pointer items-center justify-center rounded-xl px-2 py-2.5 text-sm font-medium text-zinc-400"
      >
        <IconSun className="h-4 w-4" />
      </button>
    );
  }

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="flex w-full cursor-pointer items-center rounded-xl text-sm font-medium text-zinc-400 transition-all duration-200 hover:bg-zinc-800/10 dark:hover:bg-white/[0.045] hover:text-zinc-900 dark:hover:text-zinc-100"
      style={collapsed ? { justifyContent: "center", padding: "0.625rem 0.5rem" } : { gap: "0.75rem", padding: "0.625rem 0.75rem" }}
    >
      {isDark ? <IconSun className="h-4 w-4" /> : <IconMoon className="h-4 w-4" />}
      <span className={collapsed ? "hidden" : "md:inline"}>{isDark ? "Light mode" : "Dark mode"}</span>
    </button>
  );
}
