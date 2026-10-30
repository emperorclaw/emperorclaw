/**
 * The most common error strings the UI's own API routes return, mapped to
 * messages (apiErrors.*) so a toast reads in the viewer's language. The
 * routes keep returning English (scripts and API clients read it); anything
 * not listed here shows the server's text unchanged. Never used for MCP,
 * runtime or webhook routes: agents read those.
 *
 * Pure and client-safe; the hook lives in src/lib/i18n/use-api-error.ts.
 */
import { copy, type CodedCopy } from "@/lib/coded-copy";

export type ApiErrorKey =
    | "internal" | "unauthorized" | "signInRequired" | "forbidden" | "noMembership" | "notFound" | "jsonBodyRequired"
    | "validationFailed" | "rateLimited"
    | "agentNotFound" | "taskNotFound" | "projectNotFound" | "folderNotFound" | "artifactNotFound" | "customerNotFound"
    | "viewNotFound" | "resourceNotFound" | "memberNotFound" | "companyNotFound" | "approvalNotFound"
    | "authFieldsRequired" | "missingFields" | "emailRequired" | "invalidEmail" | "emailInUse" | "passwordLength" | "passwordTooShort"
    | "companyNameRequired" | "companyNameLength" | "betaDisclaimerRequired" | "inviteOnly" | "noCompany"
    | "inviteExpired" | "inviteConsumed" | "inviteInvalid" | "inviteEmailMismatch"
    | "verificationIncomplete" | "verificationInvalid" | "resetInvalid" | "resetLinkExpired";

/** Exact server strings (as the routes write them) → message key. */
export const API_ERROR_KEYS: Readonly<Record<string, ApiErrorKey>> = {
    "Internal Server Error": "internal",
    "Internal server error": "internal",
    "server_error": "internal",
    "Unauthorized": "unauthorized",
    "Unauthorized — please log in.": "signInRequired",
    "Forbidden": "forbidden",
    "No company membership found.": "noMembership",
    "Not found": "notFound",
    "Not Found": "notFound",
    "A JSON object body is required": "jsonBodyRequired",
    "Validation failed": "validationFailed",
    "rate_limited": "rateLimited",
    "Too many requests": "rateLimited",
    "Agent not found": "agentNotFound",
    "Task not found": "taskNotFound",
    "Project not found": "projectNotFound",
    "Folder not found": "folderNotFound",
    "Artifact not found": "artifactNotFound",
    "Customer not found": "customerNotFound",
    "View not found": "viewNotFound",
    "Resource not found": "resourceNotFound",
    "Member not found": "memberNotFound",
    "Company not found": "companyNotFound",
    "Approval not found": "approvalNotFound",
    // Public auth routes (sign-up, verification, password reset).
    "Too many signup attempts. Try again later.": "rateLimited",
    "Too many reset requests. Try again later.": "rateLimited",
    "Too many verification requests. Try again later.": "rateLimited",
    "Too many verification attempts. Try again later.": "rateLimited",
    "Too many reset attempts. Try again later.": "rateLimited",
    "Too many authentication requests. Try again later.": "rateLimited",
    "Too many requests. Try again later.": "rateLimited",
    "Missing required fields: email, password": "authFieldsRequired",
    "Missing required fields": "missingFields",
    "Email is required": "emailRequired",
    "Enter a valid email address.": "invalidEmail",
    "Email already in use": "emailInUse",
    "Password must be between 8 and 128 characters.": "passwordLength",
    "Password must be at least 8 characters": "passwordTooShort",
    "Company name is required": "companyNameRequired",
    "Company name is required to set up your instance.": "companyNameRequired",
    "Company name must be between 2 and 120 characters.": "companyNameLength",
    "You must acknowledge the beta data disclaimer before creating a workspace.": "betaDisclaimerRequired",
    "This instance is invite-only. Contact your administrator for an invitation.": "inviteOnly",
    "No company found. Please contact your administrator.": "noCompany",
    "This invitation has expired. Please contact your administrator for a new one.": "inviteExpired",
    "This invitation has already been used.": "inviteConsumed",
    "Invalid or expired invitation token.": "inviteInvalid",
    "Invalid invitation.": "inviteInvalid",
    "This invitation is for a different email address.": "inviteEmailMismatch",
    "Missing verification details.": "verificationIncomplete",
    "This verification link is invalid or expired.": "verificationInvalid",
    "Invalid reset request": "resetInvalid",
    "Link expired or invalid": "resetLinkExpired",
};

/** The message key for a server error string, or null when it is not a common one. */
export function apiErrorKey(text: string | null | undefined): ApiErrorKey | null {
    const clean = typeof text === "string" ? text.trim() : "";
    if (!clean) return null;
    const exact = API_ERROR_KEYS[clean];
    if (exact) return exact;
    // requireRole: "Forbidden — this action requires one of: owner, admin."
    if (/^Forbidden\b/.test(clean)) return "forbidden";
    return null;
}

/** A server error as coded copy, or null when it is not a common one. */
export function apiErrorCopy(text: string | null | undefined): CodedCopy | null {
    const key = apiErrorKey(text);
    return key ? copy(`apiErrors.${key}`) : null;
}

/** The `error` (or `message`) field of a failed response, or null. */
export async function readApiError(res: Response): Promise<string | null> {
    const data = await res.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
    const text = typeof data?.error === "string" ? data.error : typeof data?.message === "string" ? data.message : null;
    return text && text.trim() ? text : null;
}
