import qrCode from "qrcode-generator";
import Image from "next/image";
import { getAppUrl } from "@/lib/env";

export const dynamic = "force-dynamic";
export default function MobileConnectPage() {
    const url = new URL(getAppUrl()).origin;
    const qr = qrCode(0, "M"); qr.addData(url); qr.make();
    return <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 p-6 text-foreground">
        <h1 className="text-3xl font-semibold">Connect iPhone and Apple Watch</h1>
        <p>In EmperorClaw for iPhone, open Connections → Add instance → Scan connection QR. Review this server address, then sign in and approve access.</p>
        <div className="mx-auto rounded-2xl bg-white p-4"><Image src={qr.createDataURL(6, 12)} unoptimized width={256} height={256} alt="Connection QR for this EmperorClaw server" /></div>
        <code className="break-all rounded-xl border p-4">{url}</code>
        {url.startsWith("https:") ? <p>After connecting, choose Send to Apple Watch on iPhone. Each device can switch between your saved instances independently.</p> : <p>Configure a public HTTPS address with a trusted certificate before connecting the native apps. Private servers also require network access from each device.</p>}
        <p className="text-sm text-muted-foreground">This QR contains only the server address. It contains no account credentials or API tokens.</p>
    </main>;
}
