/**
 * Client-safe onboarding data: the kinds of company the setup wizard asks
 * about, and the team it suggests for each. Roles are agent-templates ids.
 */
export const BUSINESS_TYPES = [
    { id: "software", label: "Software & product", hint: "SaaS, apps, dev studio", team: ["boss", "developer", "qa"] },
    { id: "agency", label: "Marketing agency", hint: "Campaigns, content, SEO for clients", team: ["boss", "growth", "content", "seo"] },
    { id: "ecommerce", label: "E-commerce", hint: "Online store, D2C brand", team: ["boss", "support", "growth", "content"] },
    { id: "services", label: "Services & consulting", hint: "Clients, proposals, delivery", team: ["boss", "growth", "analyst"] },
    { id: "finance", label: "Finance & accounting", hint: "Books, reporting, analysis", team: ["boss", "accountant", "analyst"] },
    { id: "other", label: "Something else", hint: "Start with a lead and add as you go", team: ["boss"] },
] as const;

export type BusinessTypeId = typeof BUSINESS_TYPES[number]["id"];

/** Short default agent names per role, so nobody has to invent one to start. */
export const DEFAULT_AGENT_NAMES: Record<string, string> = {
    boss: "Boss",
    developer: "Builder",
    qa: "Tester",
    growth: "Growth",
    content: "Writer",
    seo: "SEO",
    accountant: "Ledger",
    support: "Support",
    analyst: "Analyst",
};

/** The wizard starts small: the lead plus up to two specialists preselected. */
export function suggestedTeam(type: string | null | undefined): string[] {
    const found = BUSINESS_TYPES.find((t) => t.id === type);
    return (found?.team ?? ["boss"]).slice(0, 3);
}

export const MAX_WIZARD_AGENTS = 4;
