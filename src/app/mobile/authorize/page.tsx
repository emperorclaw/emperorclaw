import { redirect } from "next/navigation";
import { getValidatedServerSession } from "@/lib/auth";
import { issueMobileCode } from "@/lib/mobile-auth";
import { MOBILE_CALLBACK, validMobileAuthorization } from "@/lib/mobile-contract";

// Protected by the regular browser-session middleware. Server Actions add
// origin/CSRF checks; the native callback is a fixed allow-listed constant.
export default async function MobileAuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const params = await searchParams;
    const input = { challenge: String(params.challenge ?? ""), state: String(params.state ?? ""), deviceName: String(params.deviceName ?? "") };
    const valid = validMobileAuthorization(input);
    async function decide(form: FormData) {
        "use server";
        if (!validMobileAuthorization(input)) throw new Error("Invalid mobile authorization request");
        const session = await getValidatedServerSession();
        if (!session?.sessionId || !session.user?.id) throw new Error("Sign in again to connect");
        const callback = new URL(MOBILE_CALLBACK);
        callback.searchParams.set("state", input.state);
        if (form.get("decision") === "approve") callback.searchParams.set("code", await issueMobileCode(session.sessionId, session.user.id, input.challenge, input.deviceName));
        else callback.searchParams.set("error", "access_denied");
        redirect(callback.toString());
    }
    return <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <section className="w-full max-w-md space-y-6 rounded-2xl border bg-card p-6">
            <h1 className="text-2xl font-semibold">Connect EmperorClaw for iPhone</h1>
            {valid ? <>
                <p>Allow {input.deviceName} to read your accessible companies and agent activity on this server. Your existing permissions still apply.</p>
                <p className="text-sm text-muted-foreground">You can revoke this device in Settings → Account → Sessions. This connection does not create an administrator or MCP token.</p>
                <form action={decide} className="space-y-3">
                    <button name="decision" value="approve" className="min-h-12 w-full rounded-xl bg-primary px-4 text-primary-foreground">Connect iPhone</button>
                    <button name="decision" value="deny" className="min-h-12 w-full rounded-xl border px-4">Cancel</button>
                </form>
            </> : <p>This connection request is invalid. Start again from the iPhone app.</p>}
        </section>
    </main>;
}
