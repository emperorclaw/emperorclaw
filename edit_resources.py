import re

file_path = r"c:\Users\JZ\Documents\w\emperorclaw\src\app\(app)\resources\resources-client.tsx"

with open(file_path, "r", encoding="utf-8") as f:
    content = f.read()

# Edit 1: type ResourceRecord
content = content.replace(
    "configJson: Record<string, unknown>;",
    "configJson: any;"
)

# Edit 2: RESOURCE_TEMPLATES
old_templates = """const RESOURCE_TEMPLATES: Record<string, { provider: string; configJson: string; secretJson: string; helper: string }> = {
    mailbox: {
        provider: "email",
        configJson: JSON.stringify({ protocol: "imap", address: "finance@example.com", host: "imap.example.com", port: 993 }, null, 2),
        secretJson: JSON.stringify({ password: "replace_me" }, null, 2),
        helper: "Use customer or project scope for mailboxes and invoice inboxes.",
    },
    identity: {
        provider: "identity",
        configJson: JSON.stringify({ displayName: "Accounts Payable", signature: "Accounts Payable Team" }, null, 2),
        secretJson: JSON.stringify({}, null, 2),
        helper: "Use this for sender names, signatures, and project-facing personas.",
    },
    template: {
        provider: "template",
        configJson: JSON.stringify({ format: "markdown", kind: "invoice_summary", pathHint: "templates/invoice-summary.md" }, null, 2),
        secretJson: JSON.stringify({}, null, 2),
        helper: "Templates belong here when they should be durable and reusable.",
    },
    billing_profile: {
        provider: "billing",
        configJson: JSON.stringify({ legalName: "Example GmbH", vatId: "DE123456789", address: "Berlin" }, null, 2),
        secretJson: JSON.stringify({}, null, 2),
        helper: "Use billing profiles for company invoice metadata and fiscal context.",
    },
    external_account: {
        provider: "generic",
        configJson: JSON.stringify({ baseUrl: "https://api.example.com", accountId: "acct_123" }, null, 2),
        secretJson: JSON.stringify({ token: "replace_me" }, null, 2),
        helper: "Generic external accounts are the fallback for arbitrary credentials or connector metadata.",
    },
    knowledge_base: {
        provider: "knowledge",
        configJson: JSON.stringify({ location: "s3://bucket/folder", format: "pdf" }, null, 2),
        secretJson: JSON.stringify({}, null, 2),
        helper: "Use knowledge-base resources for durable file sets or reference corpora.",
    },
};"""

new_templates = """const RESOURCE_TEMPLATES: Record<string, { provider: string; configText: string; helper: string }> = {
    mailbox: {
        provider: "email",
        configText: "protocol: imap\\naddress: finance@example.com\\nhost: imap.example.com\\nport: 993",
        helper: "Use customer or project scope for mailboxes and invoice inboxes.",
    },
    identity: {
        provider: "identity",
        configText: "displayName: Accounts Payable\\nsignature: Accounts Payable Team",
        helper: "Use this for sender names, signatures, and project-facing personas.",
    },
    template: {
        provider: "template",
        configText: "format: markdown\\nkind: invoice_summary\\npathHint: templates/invoice-summary.md",
        helper: "Templates belong here when they should be durable and reusable.",
    },
    billing_profile: {
        provider: "billing",
        configText: "legalName: Example GmbH\\nvatId: DE123456789\\naddress: Berlin",
        helper: "Use billing profiles for company invoice metadata and fiscal context.",
    },
    external_account: {
        provider: "generic",
        configText: "baseUrl: https://api.example.com\\naccountId: acct_123",
        helper: "Generic external accounts are the fallback for arbitrary credentials or connector metadata.",
    },
    knowledge_base: {
        provider: "knowledge",
        configText: "location: s3://bucket/folder\\nformat: pdf",
        helper: "Use knowledge-base resources for durable file sets or reference corpora.",
    },
};"""

content = content.replace(old_templates, new_templates)

# Edit 3: safeJsonParse function removal
old_safejson = """function safeJsonParse(input: string, label: string) {
    try {
        const parsed = JSON.parse(input);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error(`${label} must be a JSON object.`);
        }
        return parsed as Record<string, unknown>;
    } catch (error) {
        throw new Error(error instanceof Error ? error.message : `Invalid ${label}.`);
    }
}"""
content = content.replace(old_safejson, "")

# Edit 4: useState variables
content = content.replace(
    'const [configJson, setConfigJson] = useState(RESOURCE_TEMPLATES.external_account.configJson);\n    const [secretJson, setSecretJson] = useState(RESOURCE_TEMPLATES.external_account.secretJson);',
    'const [configText, setConfigText] = useState(RESOURCE_TEMPLATES.external_account.configText);'
)

# Edit 5: applyTemplate function
old_applyTemplate = """    const applyTemplate = (nextType: string) => {
        const template = RESOURCE_TEMPLATES[nextType] || RESOURCE_TEMPLATES.external_account;
        setResourceType(nextType);
        setProvider(template.provider);
        setConfigJson(template.configJson);
        setSecretJson(template.secretJson);
    };"""

new_applyTemplate = """    const applyTemplate = (nextType: string) => {
        const template = RESOURCE_TEMPLATES[nextType] || RESOURCE_TEMPLATES.external_account;
        setResourceType(nextType);
        setProvider(template.provider);
        setConfigText(template.configText);
    };"""

content = content.replace(old_applyTemplate, new_applyTemplate)

# Edit 6: payload creation
old_payload = """            const payload = {
                scopeType,
                scopeId: scopeType === "company" ? null : scopeId || null,
                provider: provider.trim() || "generic",
                resourceType,
                name: name.trim(),
                displayName: displayName.trim() || null,
                configJson: safeJsonParse(configJson, "Config JSON"),
                secretJson: safeJsonParse(secretJson, "Secret JSON"),
            };"""

new_payload = """            const payload = {
                scopeType,
                scopeId: scopeType === "company" ? null : scopeId || null,
                provider: provider.trim() || "generic",
                resourceType,
                name: name.trim(),
                displayName: displayName.trim() || null,
                configJson: configText,
                secretJson: {},
            };"""

content = content.replace(old_payload, new_payload)

# Edit 7: Modal text text-zinc-400
old_p = """                            <p className="text-sm text-zinc-400">
                                Store structured metadata in <span className="font-mono text-zinc-300">configJson</span> and secrets in <span className="font-mono text-zinc-300">secretJson</span>.
                                This is intentionally generic so the runtime can lease what it actually knows how to consume.
                            </p>"""
new_p = """                            <p className="text-sm text-zinc-400">
                                Store context and configuration details in <span className="font-mono text-zinc-300">Configuration</span> as Markdown or text.
                                Secrets are currently disabled.
                            </p>"""
content = content.replace(old_p, new_p)

# Edit 8: Textareas
old_textareas = """                            <div className="grid gap-4 md:grid-cols-2">
                                <label className="space-y-1.5 text-sm">
                                    <span className="text-zinc-500">Config JSON</span>
                                    <textarea
                                        value={configJson}
                                        onChange={(event) => setConfigJson(event.target.value)}
                                        className="h-56 w-full resize-y rounded-md border border-zinc-800 bg-zinc-900 p-3 font-mono text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                    />
                                </label>
                                <label className="space-y-1.5 text-sm">
                                    <span className="text-zinc-500">Secret JSON</span>
                                    <textarea
                                        value={secretJson}
                                        onChange={(event) => setSecretJson(event.target.value)}
                                        className="h-56 w-full resize-y rounded-md border border-zinc-800 bg-zinc-900 p-3 font-mono text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                    />
                                </label>
                            </div>"""

new_textareas = """                            <div className="grid gap-4">
                                <label className="space-y-1.5 text-sm">
                                    <span className="text-zinc-500">Configuration (Markdown)</span>
                                    <textarea
                                        value={configText}
                                        onChange={(event) => setConfigText(event.target.value)}
                                        className="h-56 w-full resize-y rounded-md border border-zinc-800 bg-zinc-900 p-3 font-mono text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                    />
                                </label>
                            </div>"""
content = content.replace(old_textareas, new_textareas)

# Edit 9: List view
old_list_render = """                        <div className="grid gap-4 p-5 md:grid-cols-2">
                            <div>
                                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Config JSON</div>
                                <pre className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900 p-4 text-xs text-zinc-300">{JSON.stringify(resource.configJson || {}, null, 2)}</pre>
                            </div>
                            <div>
                                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Secrets</div>
                                <div className="rounded-md border border-zinc-800 bg-zinc-900 p-4 text-xs text-zinc-500">
                                    Stored securely. Secret values are not echoed back into the UI.
                                </div>
                            </div>
                        </div>"""

new_list_render = """                        <div className="grid gap-4 p-5">
                            <div>
                                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Configuration</div>
                                <pre className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900 p-4 text-xs text-zinc-300 whitespace-pre-wrap">{typeof resource.configJson === 'string' ? resource.configJson : JSON.stringify(resource.configJson || {}, null, 2)}</pre>
                            </div>
                        </div>"""
content = content.replace(old_list_render, new_list_render)

# Write back
with open(file_path, "w", encoding="utf-8") as f:
    f.write(content)

print("resources-client.tsx updated.")
