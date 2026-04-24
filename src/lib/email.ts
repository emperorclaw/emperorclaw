import nodemailer from "nodemailer";

// Use environment variables for SMTP configuration.
// Fallback to empty strings to avoid crashing if unset (will fail on send instead).
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || "Emperor Claw <noreply@emperorclaw.com>";

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

function renderEmailShell({
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
                        If the button does not work, copy and paste this link into your browser:<br/>
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
    if (!SMTP_HOST || !SMTP_USER) {
        console.warn("SMTP credentials not configured. Email not sent to:", to);
        console.log("--- Email Content ---");
        console.log(`Subject: ${subject}`);
        console.log(html);
        console.log("---------------------");
        return false;
    }

    try {
        const info = await transporter.sendMail({
            from: sanitizeHeaderValue(SMTP_FROM, "SMTP_FROM"),
            to: sanitizeHeaderValue(to, "recipient"),
            subject: sanitizeHeaderValue(subject, "subject"),
            html,
        });
        console.log(`Email sent: ${info.messageId}`);
        return true;
    } catch (error) {
        console.error("Error sending email:", error);
        return false;
    }
}

export function getWelcomeEmailHtml(email: string) {
    const safeEmail = escapeHtml(email);
    return renderEmailShell({
        preheader: "Your Emperor Claw workspace is ready.",
        eyebrow: "Workspace Ready",
        title: "Welcome to Emperor Claw",
        intro: "Your control plane is ready. You can now log in and start operating agents inside your workspace.",
        bodyHtml: `
            <p style="margin:0 0 16px;">Hello <strong>${safeEmail}</strong>,</p>
            <p style="margin:0 0 16px;">Thanks for joining Emperor Claw. This workspace gives your OpenClaw agents durable coordination, scoped resources, and operational state inside a shared company environment.</p>
            <p style="margin:0;">Start by logging in, connecting your first agents, and reviewing the setup guide before you rely on the workspace for production-critical operations.</p>
        `,
        footnote: "Beta software. Emperor Claw is provided as-is without warranties or guarantees of safety, retention, recovery, availability, or fitness for any purpose. You remain responsible for what you store and operate in the workspace.",
    });
}

export function getEmailVerificationEmailHtml(email: string, verificationUrl: string, companyName: string) {
    const safeEmail = escapeHtml(email);
    const safeCompanyName = escapeHtml(companyName);

    return renderEmailShell({
        preheader: "Verify your email to activate your Emperor Claw workspace.",
        eyebrow: "Email Verification",
        title: "Confirm your email address",
        intro: "Verify this address to activate your workspace and finish signup.",
        bodyHtml: `
            <p style="margin:0 0 16px;">Hello <strong>${safeEmail}</strong>,</p>
            <p style="margin:0 0 16px;">A new Emperor Claw workspace was created for <strong>${safeCompanyName}</strong>. Confirm this email address to activate access.</p>
            <div style="margin:20px 0;padding:18px;border-radius:16px;background:#eff6ff;border:1px solid #bfdbfe;">
                <p style="margin:0 0 8px;font-weight:600;color:#1d4ed8;">Before you continue</p>
                <p style="margin:0;color:#334155;">Emperor Claw is in beta. We do not guarantee safety, retention, recovery, uninterrupted availability, or suitability for regulated or business-critical workloads.</p>
            </div>
            <p style="margin:0 0 16px;">Do not store secrets, regulated data, production-only credentials, or any information you cannot afford to expose, lose, or recreate.</p>
            <p style="margin:0;">This verification link expires in 24 hours. If you did not initiate this signup, you can ignore this email.</p>
        `,
        ctaLabel: "Verify Email",
        ctaUrl: verificationUrl,
        footnote: "By activating the workspace, you acknowledge that Emperor Claw is beta software provided as-is and that you remain responsible for how it is used and what data is stored inside it.",
    });
}

export function getPasswordResetEmailHtml(email: string, resetUrl: string) {
    const safeEmail = escapeHtml(email);
    return renderEmailShell({
        preheader: "Reset your Emperor Claw password.",
        eyebrow: "Account Security",
        title: "Reset your password",
        intro: "Use the secure link below to choose a new password for your Emperor Claw account.",
        bodyHtml: `
            <p style="margin:0 0 16px;">Hello <strong>${safeEmail}</strong>,</p>
            <p style="margin:0 0 16px;">We received a request to reset the password for this account. If that was you, use the link below to set a new password.</p>
            <p style="margin:0;">If you did not request a reset, you can ignore this message. Your existing password will remain unchanged.</p>
        `,
        ctaLabel: "Reset Password",
        ctaUrl: resetUrl,
        footnote: "For your protection, password reset links expire automatically and active browser sessions are revoked after a successful password change.",
    });
}
