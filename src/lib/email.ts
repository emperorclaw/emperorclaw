import nodemailer from "nodemailer";
import { recordOpsError } from "@/lib/ops-events";

// Temporary hardcoded SMTP defaults for deployment bootstrap.
// Environment variables still override these values when present.
const SMTP_HOST = process.env.SMTP_HOST || "smtp.migadu.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "465", 10);
const SMTP_USER = process.env.SMTP_USER || "no-reply@malecu.eu";
const SMTP_PASS = process.env.SMTP_PASS || "SMTP_PASSWORD_REDACTED";
const SMTP_FROM = process.env.SMTP_FROM || "Emperor Claw Beta <no-reply@malecu.eu>";

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

    return `<!doctype html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#111827;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;">${safePreheader}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;">
        <tr>
          <td style="padding-bottom:20px;text-align:center;">
            <div style="font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:#64748b;">Emperor Claw</div>
          </td>
        </tr>
        <tr>
          <td style="background:#ffffff;border:1px solid #e2e8f0;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.06);">
            <div style="padding:28px 28px 0;background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);">
              <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#93c5fd;">${safeEyebrow}</div>
              <h1 style="margin:10px 0 0;font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.02em;">${safeTitle}</h1>
              <p style="margin:10px 0 0;font-size:15px;line-height:1.6;color:#cbd5e1;padding-bottom:28px;">${safeIntro}</p>
            </div>
            <div style="padding:28px;">
              <div style="font-size:15px;line-height:1.7;color:#334155;">
                ${bodyHtml}
              </div>
              ${ctaUrl && ctaLabel ? `
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin:28px 0 0;">
                <tr>
                  <td style="border-radius:12px;background:#2563eb;">
                    <a href="${safeCtaUrl}" style="display:inline-block;padding:14px 24px;border-radius:12px;background:#2563eb;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;">
                      ${safeCtaLabel}
                    </a>
                  </td>
                </tr>
              </table>
              <div style="margin-top:18px;font-size:13px;line-height:1.7;color:#64748b;">
                If the button does not work, copy this link into your browser:<br/>
                <a href="${safeCtaUrl}" style="color:#2563eb;word-break:break-all;">${safeCtaUrl}</a>
              </div>` : ""}
              ${safeFootnote ? `
              <div style="margin-top:24px;padding:16px 18px;border-radius:12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:12px;line-height:1.7;color:#64748b;">
                ${safeFootnote}
              </div>` : ""}
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 8px 0;text-align:center;">
            <p style="margin:0;font-size:12px;line-height:1.7;color:#64748b;">
              Malecu s.r.o. · Dolezalova 15C, 82104 Bratislava<br/>
              <a href="mailto:hello@malecu.eu" style="color:#2563eb;text-decoration:none;">hello@malecu.eu</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendEmail({ to, subject, html }: { to: string; subject: string; html: string }) {
    if (!SMTP_HOST || !SMTP_USER) {
        console.warn("SMTP credentials not configured. Email not sent to:", to);
        console.log("--- Email Content ---");
        console.log(`Subject: ${subject}`);
        console.log(html);
        console.log("--------------------");
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

export function getWelcomeEmailHtml(email: string) {
    const safeEmail = escapeHtml(email);
    return renderEmailShell({
        preheader: "Your Emperor Claw workspace is ready.",
        eyebrow: "Workspace Ready",
        title: "Welcome to Emperor Claw",
        intro: "Your control plane is ready. Log in and start operating agents inside your workspace.",
        bodyHtml: `
            <p style="margin:0 0 16px;">Hello <strong>${safeEmail}</strong>,</p>
            <p style="margin:0 0 16px;">Thanks for joining Emperor Claw. This workspace gives your agents durable coordination, scoped resources, and operational state.</p>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;">
              <div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;margin-bottom:8px;">Quick start</div>
              <ol style="margin:0;padding-left:18px;font-size:14px;line-height:1.8;color:#334155;">
                <li>Log in with your credentials</li>
                <li>Connect your first agents</li>
                <li>Review the setup guide</li>
              </ol>
            </div>
            <p style="margin:16px 0 0;font-size:14px;color:#64748b;">Beta software — provided as-is. Review expectations before relying on it for production-critical operations.</p>
        `,
        footnote: "Emperor Claw is beta software provided as-is. You remain responsible for what you store and operate.",
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
            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:16px;">
              <p style="margin:0 0 6px;font-weight:600;color:#1d4ed8;font-size:14px;">Before you continue</p>
              <p style="margin:0;font-size:13px;color:#334155;">Emperor Claw is in beta. Do not store secrets, regulated data, or any information you cannot afford to expose or lose. This link expires in 24 hours.</p>
            </div>
            <p style="margin:16px 0 0;font-size:13px;color:#64748b;">If you did not initiate this signup, ignore this email.</p>
        `,
        ctaLabel: "Verify Email",
        ctaUrl: verificationUrl,
        footnote: "By activating the workspace, you acknowledge Emperor Claw is beta software and you remain responsible for how it is used.",
    });
}

export function getPasswordResetEmailHtml(email: string, resetUrl: string) {
    const safeEmail = escapeHtml(email);
    return renderEmailShell({
        preheader: "Reset your Emperor Claw password.",
        eyebrow: "Account Security",
        title: "Reset your password",
        intro: "Use the secure link below to choose a new password.",
        bodyHtml: `
            <p style="margin:0 0 16px;">Hello <strong>${safeEmail}</strong>,</p>
            <p style="margin:0 0 16px;">We received a request to reset the password for this account. Use the link below to set a new password.</p>
            <p style="margin:16px 0 0;font-size:14px;color:#64748b;">If you did not request a reset, ignore this message. Your existing password will remain unchanged.</p>
        `,
        ctaLabel: "Reset Password",
        ctaUrl: resetUrl,
        footnote: "Password reset links expire automatically. Active browser sessions are revoked after a successful password change.",
    });
}
