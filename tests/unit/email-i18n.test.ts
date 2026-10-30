import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    emailVerificationSubject,
    getEmailVerificationEmailHtml,
    getInvitationEmail,
    getPasswordResetEmailHtml,
    getWelcomeEmailHtml,
    passwordResetSubject,
    yourCompanyLabel,
} from "../../src/lib/email";
import { notificationEmailHtml } from "../../src/lib/notifications";
import { emailLocale } from "../../src/i18n/server-translator";
import { withEnglishFallback } from "../../src/i18n/fallback";

const ROOT = path.join(__dirname, "..", "..");
type Tree = { [key: string]: string | Tree };
const load = (file: string) => JSON.parse(readFileSync(path.join(ROOT, "messages", file), "utf8")) as Tree;
const en = load("en.json");
const zh = withEnglishFallback(en, load("zh-CN.json"));
const message = (tree: Tree, key: string) => key.split(".").reduce<string | Tree>((node, part) => (node as Tree)[part], tree) as string;
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

test("emails render in English by default, unchanged in wording", () => {
    assert.equal(passwordResetSubject(), "Reset your Emperor Claw Password");
    assert.equal(emailVerificationSubject("en"), "Verify your Emperor Claw email");
    const reset = getPasswordResetEmailHtml("ana@example.com", "https://app.test/reset?token=t", "en");
    assert.match(reset, /Reset your password/);
    assert.match(reset, /Hello <strong>ana@example\.com<\/strong>,/);
    assert.match(reset, /If the button does not work, copy and paste this link into your browser:/);
    assert.match(reset, />\s*Reset Password\s*</);
    const verify = getEmailVerificationEmailHtml("ana@example.com", "https://app.test/v", "Acme <Corp>");
    assert.match(verify, /A new Emperor Claw workspace was created for <strong>Acme &lt;Corp&gt;<\/strong>\. Confirm this email address to activate access\./);
    assert.match(getWelcomeEmailHtml("ana@example.com"), /Welcome to Emperor Claw/);
    assert.equal(yourCompanyLabel(), "your company");
});

test("emails render in Simplified Chinese for a zh-CN recipient (English where a message is untranslated)", () => {
    const zhMessage = (key: string) => escape(message(zh, key));
    assert.equal(passwordResetSubject("zh-CN"), message(zh, "email.passwordReset.subject"));
    assert.equal(emailVerificationSubject("zh-CN"), message(zh, "email.verification.subject"));
    const reset = getPasswordResetEmailHtml("ana@example.com", "https://app.test/r", "zh-CN");
    for (const key of ["email.passwordReset.title", "email.passwordReset.cta", "email.passwordReset.footnote", "email.linkFallback"]) {
        assert.ok(reset.includes(zhMessage(key)), `${key} in the zh-CN email`);
    }
    // The address is still the value, bold and escaped, inside the translated greeting.
    assert.ok(reset.includes("<strong>ana@example.com</strong>"));
    const verify = getEmailVerificationEmailHtml("ana@example.com", "https://app.test/v", "Acme", "zh-CN");
    assert.ok(verify.includes(zhMessage("email.verification.title")));
    assert.ok(verify.includes(zhMessage("email.verification.cta")));
    const welcome = getWelcomeEmailHtml("ana@example.com", "zh-CN");
    assert.ok(welcome.includes(zhMessage("email.welcome.title")));
    // An unknown locale falls back to English.
    assert.equal(passwordResetSubject("fr"), "Reset your Emperor Claw Password");
});

test("invitation email: subject, escaped values and a localized date", () => {
    const expiresAt = new Date("2026-11-06T12:00:00Z");
    const english = getInvitationEmail({ companyName: "Acme & Co", role: "editor", inviteUrl: "https://app.test/signup?invite=x&email=a%40b.c", expiresAt });
    assert.equal(english.subject, "You're invited to join Acme & Co on Emperor Claw");
    assert.match(english.html, /You&#39;ve been invited to join <strong>Acme &amp; Co<\/strong> as a <strong>editor<\/strong>\./);
    assert.match(english.html, /href="https:\/\/app\.test\/signup\?invite=x&amp;email=a%40b\.c"/);
    assert.match(english.html, /This invitation expires on November 6, 2026\./);
    assert.equal(getInvitationEmail({ companyName: null, role: "viewer", inviteUrl: "u", expiresAt }).subject, "You're invited to join the workspace on Emperor Claw");
    const chinese = getInvitationEmail({ companyName: "Acme", role: "editor", inviteUrl: "u", expiresAt, locale: "zh-CN" });
    assert.ok(chinese.html.includes(escape(message(zh, "email.invitation.accept"))));
    assert.ok(chinese.html.includes("2026"), "the date is formatted, not left as a placeholder");
});

test("notification email: the stored title stays, the frame follows the recipient's language", () => {
    const html = notificationEmailHtml("Atlas needs approval", "Publish the post?", "https://app.test/inbox");
    assert.match(html, /Atlas needs approval/);
    assert.match(html, />Open in EmperorClaw</);
    assert.match(html, /You can change which notifications you get by email in Settings → Notifications\./);
    const chinese = notificationEmailHtml("Atlas needs approval", null, "https://app.test/inbox", "zh-CN");
    assert.match(chinese, /Atlas needs approval/);
    assert.ok(chinese.includes(escape(message(zh, "email.notification.open"))));
});

test("emailLocale: saved preference, then the browser, then English", () => {
    const req = (acceptLanguage: string | null, cookie?: string) => ({
        headers: { get: (name: string) => (name === "accept-language" ? acceptLanguage : null) },
        cookies: { get: (name: string) => (name === "NEXT_LOCALE" && cookie ? { value: cookie } : undefined) },
    });
    assert.equal(emailLocale(req("en-US"), "zh-CN"), "zh-CN", "saved preference wins");
    assert.equal(emailLocale(req("zh-CN,zh;q=0.9"), null), "zh-CN", "Automatic follows the browser");
    assert.equal(emailLocale(req("en", "zh-CN"), null), "en", "Automatic ignores the mirrored cookie");
    assert.equal(emailLocale(req("en", "zh-CN")), "zh-CN", "not read: the cookie mirrors the preference");
    assert.equal(emailLocale(req(null), "garbage"), "en");
    assert.equal(emailLocale(null, null), "en");
});
