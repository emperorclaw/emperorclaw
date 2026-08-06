import { getOAuthClient, validateRedirectUri } from "@/lib/oauth";
import { getValidatedServerSession, getCompanyId } from "@/lib/auth";
import { getAppUrl } from "@/lib/env";
import { db } from "@/db";
import { companies } from "@/db/schema";
import { eq } from "drizzle-orm";
import { CustomLogo } from "@/components/custom-logo";

// Protected automatically by src/proxy.ts's default withAuth gate (not in
// its public matcher) — an unauthenticated visitor is bounced to /login
// first, same as every other app page, then lands back here.
export default async function AuthorizePage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    const clientId = typeof params.client_id === "string" ? params.client_id : "";
    const redirectUri = typeof params.redirect_uri === "string" ? params.redirect_uri : "";
    const codeChallenge = typeof params.code_challenge === "string" ? params.code_challenge : "";
    const codeChallengeMethod = typeof params.code_challenge_method === "string" ? params.code_challenge_method : "";
    const state = typeof params.state === "string" ? params.state : "";
    const responseType = typeof params.response_type === "string" ? params.response_type : "";

    const errors: string[] = [];
    if (responseType !== "code") errors.push("response_type must be 'code'.");
    if (codeChallengeMethod !== "S256") errors.push("code_challenge_method must be 'S256'.");
    if (!codeChallenge) errors.push("code_challenge is required.");

    const client = clientId ? await getOAuthClient(clientId) : null;
    if (!client) errors.push("Unknown client_id — this app hasn't registered with EmperorClaw.");
    if (client && !validateRedirectUri(client, redirectUri)) {
        errors.push("redirect_uri does not match what this client registered.");
    }

    // Non-blocking, not a hard error: a reverse proxy terminating TLS in
    // front of a plain-HTTP app container would correctly report https via
    // APP_URL, so this can't be certain in every deployment topology — but
    // OAuth 2.1 requires TLS on every authorization-server endpoint, and
    // claude.ai's client will very likely reject (or the browser will warn
    // hard on) a plain-HTTP issuer. Self-hosted installs default to plain
    // HTTP (docker-compose.yml's APP_URL=http://localhost:3000), so this is
    // a real, common case, not a hypothetical one.
    const isHttps = getAppUrl().startsWith("https://");

    const session = await getValidatedServerSession();
    const companyId = await getCompanyId();
    const [company] = companyId ? await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1) : [];

    return (
        <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
            <div className="w-full max-w-md rounded-3xl border border-white/10 bg-zinc-900/70 p-8 shadow-2xl">
                <div className="mb-6 flex justify-center"><CustomLogo /></div>

                {!isHttps && (
                    <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-200">
                        This instance isn&apos;t served over HTTPS. OAuth requires TLS on every step — claude.ai will likely fail to complete this even if you approve below. Put a reverse proxy (Caddy, nginx, Cloudflare Tunnel) in front with a real certificate, or use a manually-created Bearer token instead (Settings → Tokens) — that works over plain HTTP fine.
                    </div>
                )}

                {errors.length > 0 ? (
                    <div className="space-y-3">
                        <h1 className="text-center text-lg font-semibold text-rose-300">Can&apos;t connect this app</h1>
                        <ul className="list-inside list-disc space-y-1 text-sm text-zinc-400">
                            {errors.map((e) => <li key={e}>{e}</li>)}
                        </ul>
                    </div>
                ) : (
                    <>
                        <h1 className="text-center text-lg font-semibold text-zinc-100">
                            {client?.clientName || "An app"} wants to connect
                        </h1>
                        <p className="mt-2 text-center text-sm text-zinc-400">
                            {session?.user?.email} · <span className="text-zinc-300">{company?.name || "your company"}</span>
                        </p>
                        <div className="mt-6 rounded-2xl border border-white/10 bg-black/25 p-4 text-sm text-zinc-400">
                            This grants access to agents, tasks, projects, Knowledge &amp; Rules, and messaging for this company — the same access a manually-created Agent access token has. You can revoke it any time from Settings → Tokens.
                        </div>
                        <form method="POST" action="/api/oauth/authorize" className="mt-6 space-y-3">
                            <input type="hidden" name="client_id" value={clientId} />
                            <input type="hidden" name="redirect_uri" value={redirectUri} />
                            <input type="hidden" name="code_challenge" value={codeChallenge} />
                            <input type="hidden" name="code_challenge_method" value={codeChallengeMethod} />
                            <input type="hidden" name="state" value={state} />
                            <button
                                type="submit"
                                name="decision"
                                value="approve"
                                className="w-full rounded-xl bg-cyan-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-cyan-500"
                            >
                                Approve
                            </button>
                            <button
                                type="submit"
                                name="decision"
                                value="deny"
                                className="w-full rounded-xl border border-white/10 px-4 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-white/5"
                            >
                                Deny
                            </button>
                        </form>
                    </>
                )}
            </div>
        </div>
    );
}
