import { withAuth } from "next-auth/middleware";

export default withAuth({
    pages: {
        signIn: "/login",
    },
});


export const config = {
    // Protect all routes except the standard auth api, MCP APIs, webhooks, public assets, docs, and the login/signup pages
    matcher: ["/((?!api/auth|api/mcp|api/webhook|api/skills|api/docs|docs|_next/static|_next/image|favicon.ico|login|signup|setup|install\\.sh|install\\.ps1|downloads).*)"],
};
