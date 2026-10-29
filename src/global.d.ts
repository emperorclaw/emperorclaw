import type en from "../messages/en.json";
import type { Locale } from "@/i18n/config";

// Type-safe message keys: messages/en.json is the source of truth.
declare module "next-intl" {
    interface AppConfig {
        Locale: Locale;
        Messages: typeof en;
    }
}
