import zh from "../../messages/zh-CN.json";
import type { Locale } from "./config";
import { withEnglishFallback } from "./fallback";
import { englishMessages, type Messages } from "./load-messages";

let chinese: Messages | null = null;

/**
 * The signed-in app's messages, available synchronously: both locales are in
 * the app's JS (content-hashed, cached immutably), so hydration never waits on
 * a fetch and the RSC payload (re-sent by every 15 s refresh) carries none.
 */
export function appMessages(locale: Locale): Messages {
    if (locale === "en") return englishMessages;
    chinese ??= withEnglishFallback(englishMessages, zh);
    return chinese;
}
