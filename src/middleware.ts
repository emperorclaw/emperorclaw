import { withAuth } from "next-auth/middleware";

/**
 * Middleware — binary auth only.
 *
 * Strategy:
 * - `withAuth` ensures the user is logged in for all protected routes.
 * - Role enforcement happens at the API-route level via `requireRole()` from
 *   `src/lib/roles.ts`. The middleware does NOT check roles — it only gates
 *   on authentication.
 * - Public endpoints (validate-invite, auth APIs, setup, downloads) are
 *   excluded from the matcher so unauthenticated users can reach them.
 * - MCP / webhook endpoints use Bearer-token auth and are also excluded.
 */

export default withAuth({
    pages: {
        signIn: "/login",
    },
});

export const config = {
    // Protected: all app routes (dashboard, settings, projects, etc.) and
    // internal API routes that require authentication. Role gating inside
    // each route handler handles 401 vs 403 distinction.
    //
    // Excluded (public, unauthenticated):
    //   /                    — landing page
    //   /api/auth/*          — signup, login, validate-invite, password reset
    //   /api/mcp/*           — MCP Bearer-token auth
    //   /api/webhook/*       — webhook endpoints
    //   /api/skills/*        — public skill registry
    //   /api/docs/*          — public documentation API
    //   /docs/*              — documentation pages
    //   /login, /signup      — auth pages
    //   /setup, /install.*   — setup scripts
    //   /downloads/*         — public downloads
    //   /_next/*, favicon    — Next.js internals
    matcher: ["/((?!$|api/auth|api/mcp|api/webhook|api/skills|api/docs|docs|_next/static|_next/image|favicon.ico|login|signup|setup|install\\.sh|install\\.ps1|downloads).*)"],
};
