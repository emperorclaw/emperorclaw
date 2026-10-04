import { IconUsersGroup } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

/** Emoji a group can use as its icon. */
export const GROUP_ICONS = ["💻", "🧪", "📣", "🎨", "🛟", "💰", "📊", "🚀", "🧭", "📦", "✈️", "🤝", "📝", "⚙️", "🔥", "🌱"];

/** A group's emoji, or the default group glyph. */
export function GroupIcon({ icon, className }: { icon?: string | null; className?: string }) {
    if (icon) return <span aria-hidden className={cn("leading-none", className)}>{icon}</span>;
    return <IconUsersGroup className={className} />;
}
