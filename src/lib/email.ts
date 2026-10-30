import nodemailer from "nodemailer";
import { recordOpsError } from "@/lib/ops-events";
import { DEFAULT_LOCALE, type Locale } from "@/i18n/config";
import { serverTranslator, type ServerTranslator } from "@/i18n/server-translator";

// Emails are read by people, so they render in the recipient's language
// (src/i18n/server-translator.ts); the default and fallback is English.

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM;

/** Whether email sending is configured and available. */
export function isEmailConfigured(): boolean {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS && SMTP_FROM);
}

function sanitizeHeaderValue(value: string, field: string): string {
    const normalized = String(value ?? "").trim();
    if (!normalized) {
        throw new Error(`${field} is required`);
    }

    if (/[\r\n]/.test(normalized)) {
        throw new Error(`${field} contains invalid characters`);
    }

    return normalized;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
    },
});

function renderEmailShell(t: ServerTranslator, {
    preheader,
    title,
    eyebrow,
    intro,
    bodyHtml,
    ctaLabel,
    ctaUrl,
    footnote,
}: {
    preheader: string;
    title: string;
    eyebrow: string;
    intro: string;
    bodyHtml: string;
    ctaLabel?: string;
    ctaUrl?: string;
    footnote?: string;
}) {
    const safePreheader = escapeHtml(preheader);
    const safeTitle = escapeHtml(title);
    const safeEyebrow = escapeHtml(eyebrow);
    const safeIntro = escapeHtml(intro);
    const safeCtaUrl = ctaUrl ? escapeHtml(ctaUrl) : "";
    const safeCtaLabel = ctaLabel ? escapeHtml(ctaLabel) : "";
    const safeFootnote = footnote ? escapeHtml(footnote) : "";

    return `
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${safePreheader}</div>
    <div style="margin:0;background:#f5f7fb;padding:32px 16px;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#111827;">
        <div style="max-width:640px;margin:0 auto;">
            <div style="margin-bottom:16px;text-align:center;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:#64748b;">
                Emperor Claw
            </div>
            <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:24px;overflow:hidden;box-shadow:0 24px 80px rgba(15,23,42,0.08);">
                <div style="padding:28px 32px;background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);color:#f8fafc;">
                    <div style="font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#93c5fd;">${safeEyebrow}</div>
                    <h1 style="margin:12px 0 0;font-size:28px;line-height:1.2;font-weight:700;color:#ffffff;">${safeTitle}</h1>
                    <p style="margin:12px 0 0;font-size:15px;line-height:1.7;color:#cbd5e1;">${safeIntro}</p>
                </div>
                <div style="padding:32px;">
                    <div style="font-size:15px;line-height:1.7;color:#334155;">
                        ${bodyHtml}
                    </div>
                    ${ctaUrl && ctaLabel ? `
                    <div style="margin:28px 0 24px;">
                        <a href="${safeCtaUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:12px;font-weight:600;">
                            ${safeCtaLabel}
                        </a>
                    </div>
                    <div style="margin:0 0 24px;font-size:13px;line-height:1.7;color:#64748b;">
                        ${escapeHtml(t("email.linkFallback"))}<br/>
                        <a href="${safeCtaUrl}" style="color:#2563eb;word-break:break-all;">${safeCtaUrl}</a>
                    </div>` : ""}
                    ${safeFootnote ? `
                    <div style="margin-top:24px;padding:16px 18px;border-radius:16px;background:#f8fafc;border:1px solid #e2e8f0;font-size:12px;line-height:1.7;color:#64748b;">
                        ${safeFootnote}
                    </div>` : ""}
                </div>
            </div>
        </div>
    </div>
    `;
}

export async function sendEmail({ to, subject, html }: { to: string; subject: string; html: string }) {
    if (!SMTP_HOST || !SMTP_USER || !SMTP_FROM) {
        console.warn("SMTP credentials not configured. Email not sent to:", to);
        console.log("--- Email Content ---");
        console.log(`Subject: ${subject}`);
        console.log(html);
        console.log("---------------------");
        return false;
    }

    // TypeScript narrowing: all SMTP vars are strings after the guard above
    const from = SMTP_FROM as string;

    try {
        const info = await transporter.sendMail({
            from: sanitizeHeaderValue(from, "SMTP_FROM"),
            to: sanitizeHeaderValue(to, "recipient"),
            subject: sanitizeHeaderValue(subject, "subject"),
            html,
        });
        console.log(`Email sent: ${info.messageId}`);
        return true;
    } catch (error) {
        console.error("Error sending email:", error);
        void recordOpsError({
            category: "email",
            source: "mailer.send",
            fallbackMessage: "Failed to send email",
            error,
            metadata: {
                to,
                subject,
            },
        });
        return false;
    }
}

/**
 * A message as HTML: the translated text is escaped, then each value (already
 * safe HTML, such as `<strong>escaped name</strong>`) is put in its place, so
 * neither a translation nor a user-supplied value can inject markup.
 */
function messageHtml(t: ServerTranslator, key: string, values: Record<string, string> = {}): string {
    const tokens: Record<string, string> = {};
    Object.keys(values).forEach((name, index) => { tokens[name] = `\u0000${index}\u0000`; });
    let out = escapeHtml((t as unknown as (key: string, values?: Record<string, string>) => string)(key, tokens));
    Object.entries(values).forEach(([name, value]) => { out = out.split(tokens[name]).join(value); });
    return out;
}

const text = (t: ServerTranslator, key: string, values?: Record<string, string | number | Date>) =>
    (t as unknown as (key: string, values?: Record<string, string | number | Date>) => string)(key, values);

const strong = (value: string) => `<strong>${escapeHtml(value)}</strong>`;
const paragraph = (html: string, last = false) => `<p style="margin:0${last ? "" : " 0 16px"};">${html}</p>`;

export function getWelcomeEmailHtml(email: string, locale: Locale | string = DEFAULT_LOCALE) {
    const t = serverTranslator(locale);
    return renderEmailShell(t, {
        preheader: text(t, "email.welcome.preheader"),
        eyebrow: text(t, "email.welcome.eyebrow"),
        title: text(t, "email.welcome.title"),
        intro: text(t, "email.welcome.intro"),
        bodyHtml: `
            ${paragraph(messageHtml(t, "email.greeting", { email: strong(email) }))}
            ${paragraph(messageHtml(t, "email.welcome.thanks"))}
            ${paragraph(messageHtml(t, "email.welcome.start"), true)}
        `,
        footnote: text(t, "email.welcome.footnote"),
    });
}

/** The verification email's subject, in the recipient's language. */
export function emailVerificationSubject(locale: Locale | string = DEFAULT_LOCALE): string {
    return text(serverTranslator(locale), "email.verification.subject");
}

/** "your company" when a verification email has no company name to show. */
export function yourCompanyLabel(locale: Locale | string = DEFAULT_LOCALE): string {
    return text(serverTranslator(locale), "email.verification.yourCompany");
}

export function getEmailVerificationEmailHtml(email: string, verificationUrl: string, companyName: string, locale: Locale | string = DEFAULT_LOCALE) {
    const t = serverTranslator(locale);
    return renderEmailShell(t, {
        preheader: text(t, "email.verification.preheader"),
        eyebrow: text(t, "email.verification.eyebrow"),
        title: text(t, "email.verification.title"),
        intro: text(t, "email.verification.intro"),
        bodyHtml: `
            ${paragraph(messageHtml(t, "email.greeting", { email: strong(email) }))}
            ${paragraph(messageHtml(t, "email.verification.created", { company: strong(companyName) }))}
            <div style="margin:20px 0;padding:18px;border-radius:16px;background:#eff6ff;border:1px solid #bfdbfe;">
                <p style="margin:0 0 8px;font-weight:600;color:#1d4ed8;">${messageHtml(t, "email.verification.beforeTitle")}</p>
                <p style="margin:0;color:#334155;">${messageHtml(t, "email.verification.beforeBody")}</p>
            </div>
            ${paragraph(messageHtml(t, "email.verification.noSecrets"))}
            ${paragraph(messageHtml(t, "email.verification.expiry"), true)}
        `,
        ctaLabel: text(t, "email.verification.cta"),
        ctaUrl: verificationUrl,
        footnote: text(t, "email.verification.footnote"),
    });
}

/** The password reset email's subject, in the recipient's language. */
export function passwordResetSubject(locale: Locale | string = DEFAULT_LOCALE): string {
    return text(serverTranslator(locale), "email.passwordReset.subject");
}

export function getPasswordResetEmailHtml(email: string, resetUrl: string, locale: Locale | string = DEFAULT_LOCALE) {
    const t = serverTranslator(locale);
    return renderEmailShell(t, {
        preheader: text(t, "email.passwordReset.preheader"),
        eyebrow: text(t, "email.passwordReset.eyebrow"),
        title: text(t, "email.passwordReset.title"),
        intro: text(t, "email.passwordReset.intro"),
        bodyHtml: `
            ${paragraph(messageHtml(t, "email.greeting", { email: strong(email) }))}
            ${paragraph(messageHtml(t, "email.passwordReset.received"))}
            ${paragraph(messageHtml(t, "email.passwordReset.ignore"), true)}
        `,
        ctaLabel: text(t, "email.passwordReset.cta"),
        ctaUrl: resetUrl,
        footnote: text(t, "email.passwordReset.footnote"),
    });
}

/** An instance invitation (subject and body) in the inviter's language. */
export function getInvitationEmail(input: { companyName: string | null; role: string; inviteUrl: string; expiresAt: Date; locale?: Locale | string }): { subject: string; html: string } {
    const t = serverTranslator(input.locale ?? DEFAULT_LOCALE);
    const company = input.companyName || text(t, "email.invitation.theWorkspace");
    return {
        subject: text(t, "email.invitation.subject", { company }),
        html: `<p>${messageHtml(t, "email.invitation.invited", { company: strong(company), role: strong(input.role) })}</p>`
            + `<p><a href="${escapeHtml(input.inviteUrl)}">${messageHtml(t, "email.invitation.accept")}</a></p>`
            + `<p>${escapeHtml(text(t, "email.invitation.expires", { date: input.expiresAt }))}</p>`,
    };
}
