/**
 * LLM Agent Configuration — self-documenting endpoint (PaperClip-style).
 *
 * Returns per-provider configuration guides so bridges and UIs can
 * dynamically discover supported providers and their requirements.
 * API keys are NEVER stored in EmperorClaw — they live in the agent runtime.
 */
export const PROVIDER_DOCS: Record<string, {
    label: string;
    envVar: string;
    docs: string;
}> = {
    openai: {
        label: "OpenAI",
        envVar: "OPENAI_API_KEY",
        docs: `# OpenAI provider configuration

## Prerequisites
- An OpenAI API key from https://platform.openai.com/api-keys
- Set the key in your agent runtime environment

## Configuration
- Set \`OPENAI_API_KEY\` in your environment or \`~/.hermes/.env\`
- Models: gpt-4o, gpt-4o-mini, gpt-4.1, o4-mini, o3, etc.
- API keys are managed in the agent runtime — NOT stored in EmperorClaw
- EmperorClaw only stores the provider choice (\`llmProvider: "openai"\`) as metadata

## Hermes setup
\`\`\`bash
# Add to ~/.hermes/.env
OPENAI_API_KEY=sk-your-key-here
\`\`\`

## OAuth note
OAuth-based auth (Google, GitHub) is not supported via API key.
Use a manual Hermes login for OAuth providers.
`,
    },
    anthropic: {
        label: "Anthropic",
        envVar: "ANTHROPIC_API_KEY",
        docs: `# Anthropic provider configuration

## Prerequisites
- An Anthropic API key from https://console.anthropic.com/
- Set the key in your agent runtime environment

## Configuration
- Set \`ANTHROPIC_API_KEY\` in your environment or \`~/.hermes/.env\`
- Models: claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5, etc.
- API keys are managed in the agent runtime — NOT stored in EmperorClaw
- EmperorClaw only stores the provider choice (\`llmProvider: "anthropic"\`) as metadata

## Hermes setup
\`\`\`bash
# Add to ~/.hermes/.env
ANTHROPIC_API_KEY=sk-ant-your-key-here
\`\`\`
`,
    },
    google: {
        label: "Google Gemini",
        envVar: "GOOGLE_API_KEY",
        docs: `# Google Gemini provider configuration

## Prerequisites
- A Google AI API key from https://aistudio.google.com/apikey
- Set the key in your agent runtime environment

## Configuration
- Set \`GOOGLE_API_KEY\` in your environment or \`~/.hermes/.env\`
- Also accepted as \`GEMINI_API_KEY\`
- Models: gemini-2.5-pro, gemini-2.5-flash, gemini-2.0-flash, etc.
- API keys are managed in the agent runtime — NOT stored in EmperorClaw
- EmperorClaw only stores the provider choice (\`llmProvider: "google"\`) as metadata

## Hermes setup
\`\`\`bash
# Add to ~/.hermes/.env
GOOGLE_API_KEY=your-key-here
\`\`\`
`,
    },
    openrouter: {
        label: "OpenRouter",
        envVar: "OPENROUTER_API_KEY",
        docs: `# OpenRouter provider configuration

## Prerequisites
- An OpenRouter API key from https://openrouter.ai/keys
- Set the key in your agent runtime environment

## Configuration
- Set \`OPENROUTER_API_KEY\` in your environment or \`~/.hermes/.env\`
- Access to 200+ models via a single API
- API keys are managed in the agent runtime — NOT stored in EmperorClaw
- EmperorClaw only stores the provider choice (\`llmProvider: "openrouter"\`) as metadata

## Hermes setup
\`\`\`bash
# Add to ~/.hermes/.env
OPENROUTER_API_KEY=sk-or-v1-your-key-here
\`\`\`
`,
    },
    grok: {
        label: "Grok",
        envVar: "GROK_API_KEY",
        docs: `# Grok provider configuration

## Prerequisites
- A Grok API key from https://x.ai/api
- Set the key in your agent runtime environment

## Configuration
- Set \`GROK_API_KEY\` in your environment or \`~/.hermes/.env\`
- Models: grok-3, grok-3-mini, etc.
- API keys are managed in the agent runtime — NOT stored in EmperorClaw
- EmperorClaw only stores the provider choice (\`llmProvider: "grok"\`) as metadata

## Hermes setup
\`\`\`bash
# Add to ~/.hermes/.env
GROK_API_KEY=xai-your-key-here
\`\`\`
`,
    },
    deepseek: {
        label: "DeepSeek",
        envVar: "DEEPSEEK_API_KEY",
        docs: `# DeepSeek provider configuration

## Prerequisites
- A DeepSeek API key from https://platform.deepseek.com/api_keys
- Set the key in your agent runtime environment

## Configuration
- Set \`DEEPSEEK_API_KEY\` in your environment or \`~/.hermes/.env\`
- Models: deepseek-chat, deepseek-reasoner
- API keys are managed in the agent runtime — NOT stored in EmperorClaw
- EmperorClaw only stores the provider choice (\`llmProvider: "deepseek"\`) as metadata

## Hermes setup
\`\`\`bash
# Add to ~/.hermes/.env
DEEPSEEK_API_KEY=sk-your-key-here
\`\`\`
`,
    },
};

/** Ordered list for the index endpoint */
export const PROVIDER_INDEX = Object.entries(PROVIDER_DOCS).map(([id, doc]) => ({
    id,
    label: doc.label,
    envVar: doc.envVar,
}));
