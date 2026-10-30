/**
 * Why Easy Setup (local Hermes agents in sibling Docker containers) is not
 * available. GET /api/agents/easy-setup returns the English `reason` (API
 * clients read it) and its `reasonCode`; the hire dialog renders the code as
 * agents.easySetup.availability.<code> in the viewer's language.
 */
export const EASY_SETUP_REASONS = {
    sign_in: "Sign in to create a worker.",
    not_admin: "Ask a workspace owner or administrator to hire local agents.",
    no_docker: "This installation needs Docker with its socket mounted for automatic Hermes setup.",
    docker_unresponsive: "Docker is not responding. Restart Docker and retry.",
    docker_access: "The app cannot access Docker. Rerun the installer to repair socket permissions, then retry.",
} as const;

export type EasySetupReasonCode = keyof typeof EASY_SETUP_REASONS;
