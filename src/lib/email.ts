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
    return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
        <h2 style="color: #4f46e5;">Welcome to Emperor Claw</h2>
        <p>Hello <strong>${safeEmail}</strong>,</p>
        <p>We're thrilled to have you onboard. Emperor Claw is your central command plane for managing autonomous OpenClaw agents.</p>
        <p>To get started, head over to your Dashboard and follow the initial Setup Guide.</p>
        <br/>
        <p>Best regards,<br/>The Emperor Claw Team</p>
    </div>
    `;
}

export function getPasswordResetEmailHtml(email: string, resetUrl: string) {
    const safeEmail = escapeHtml(email);
    const safeResetUrl = escapeHtml(resetUrl);
    return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
        <h2 style="color: #4f46e5;">Emperor Claw Password Reset</h2>
        <p>Hello <strong>${safeEmail}</strong>,</p>
        <p>We received a request to reset your password. Click the button below to set a new one:</p>
        <div style="margin: 30px 0;">
            <a href="${safeResetUrl}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Reset Password</a>
        </div>
        <p>If the button doesn't work, copy and paste this link into your browser:</p>
        <p><a href="${safeResetUrl}" style="color: #4f46e5; word-break: break-all;">${safeResetUrl}</a></p>
        <br/>
        <p>If you did not request a password reset, you can safely ignore this email.</p>
        <p>Best,<br/>The Emperor Claw Team</p>
    </div>
    `;
}
