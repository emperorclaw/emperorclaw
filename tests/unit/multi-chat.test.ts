import test from "node:test";
import assert from "node:assert/strict";
import {
    CHAT_TITLE_MAX, chatLimitReached, deriveChatTitle, isValidClientKey, MULTI_CHAT_DEFAULTS,
    newChatTitle, normalizeChatTitle, normalizeMultiChatSettings, parseMultiChatSettingsPatch,
} from "../../src/lib/multi-chat";

test("an extra chat is titled from its first message, whitespace collapsed", () => {
    assert.equal(deriveChatTitle("  Plan the\n\nlaunch   email\t"), "Plan the launch email");
    assert.equal(deriveChatTitle(""), null, "untitled: the interface names it in the viewer's language");
    assert.equal(deriveChatTitle("   \n "), null);
    assert.equal(deriveChatTitle(null), null);
});

test("a chat started with a voice note or only an attachment is untitled, never an English caption", () => {
    const audio = [{ contentType: "audio/webm" }];
    assert.equal(newChatTitle("Voice message (12s)", audio), null);
    assert.equal(newChatTitle("🎤 Voice message (1:05)", audio), null);
    assert.equal(newChatTitle("", [{ contentType: "image/png" }]), null);
    assert.equal(newChatTitle("Voice message (12s)", []), "Voice message (12s)", "typed text is a title");
    assert.equal(newChatTitle("Voice message (12s)", [{ contentType: "image/png" }]), "Voice message (12s)");
    assert.equal(newChatTitle("Summarize this call", audio), "Summarize this call");
});

test("a long first message is cut to the title length with an ellipsis", () => {
    const exact = "a".repeat(CHAT_TITLE_MAX);
    assert.equal(deriveChatTitle(exact), exact, "exactly the limit is kept whole");
    const title = deriveChatTitle(`${"word ".repeat(40)}end`)!;
    assert.ok(Array.from(title).length <= CHAT_TITLE_MAX);
    assert.ok(title.endsWith("…"));
    assert.ok(!title.includes("  "));
});

test("title cutting never splits an emoji", () => {
    const title = deriveChatTitle("😀".repeat(CHAT_TITLE_MAX + 5))!;
    assert.equal(Array.from(title).length, CHAT_TITLE_MAX);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title), "no lone high surrogate");
});

test("cap arithmetic: the cap counts open chats, main included", () => {
    assert.equal(chatLimitReached(0, 1), false);
    assert.equal(chatLimitReached(19, 20), false);
    assert.equal(chatLimitReached(20, 20), true);
    assert.equal(chatLimitReached(25, 20), true, "a lowered cap blocks new chats but keeps the open ones");
});

test("stored settings normalize to the defaults when missing or out of range", () => {
    assert.deepEqual(normalizeMultiChatSettings(null), { ...MULTI_CHAT_DEFAULTS });
    assert.deepEqual(normalizeMultiChatSettings({ multiChatEnabled: false, multiChatMaxOpen: 5, multiChatIdleArchiveDays: null }), { enabled: false, maxOpen: 5, idleArchiveDays: null });
    assert.deepEqual(normalizeMultiChatSettings({ multiChatEnabled: "yes", multiChatMaxOpen: 500, multiChatIdleArchiveDays: 1 }), { ...MULTI_CHAT_DEFAULTS });
});

test("settings validation: ranges and types", () => {
    assert.deepEqual(parseMultiChatSettingsPatch({}), { ok: true, patch: {} });
    assert.deepEqual(parseMultiChatSettingsPatch({ mode: "private" }), { ok: true, patch: {} }, "other fields are ignored");
    assert.deepEqual(parseMultiChatSettingsPatch({ multiChatEnabled: false, multiChatMaxOpen: 50, multiChatIdleArchiveDays: null }), { ok: true, patch: { enabled: false, maxOpen: 50, idleArchiveDays: null } });
    assert.deepEqual(parseMultiChatSettingsPatch({ multiChatMaxOpen: 1, multiChatIdleArchiveDays: 7 }), { ok: true, patch: { maxOpen: 1, idleArchiveDays: 7 } });
    assert.deepEqual(parseMultiChatSettingsPatch({ multiChatIdleArchiveDays: 90 }), { ok: true, patch: { idleArchiveDays: 90 } });
    for (const bad of [
        { multiChatEnabled: "true" }, { multiChatMaxOpen: 0 }, { multiChatMaxOpen: 51 }, { multiChatMaxOpen: 2.5 }, { multiChatMaxOpen: "20" },
        { multiChatIdleArchiveDays: 6 }, { multiChatIdleArchiveDays: 91 }, { multiChatIdleArchiveDays: "never" },
    ]) {
        assert.equal(parseMultiChatSettingsPatch(bad).ok, false, JSON.stringify(bad));
    }
});

test("renames and client keys are validated", () => {
    assert.equal(normalizeChatTitle("  Q3   invoices "), "Q3 invoices");
    assert.equal(normalizeChatTitle(""), null);
    assert.equal(normalizeChatTitle("   "), null);
    assert.equal(normalizeChatTitle(42), null);
    assert.equal(normalizeChatTitle("x".repeat(CHAT_TITLE_MAX * 2 + 1)), null);
    assert.equal(isValidClientKey("c3f1a2b4-new-chat"), true);
    assert.equal(isValidClientKey("short"), false);
    assert.equal(isValidClientKey("has spaces in it"), false);
    assert.equal(isValidClientKey(undefined), false);
});
