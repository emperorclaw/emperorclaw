import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import i18next from "eslint-plugin-i18next";

/**
 * Screens whose copy lives in messages/*.json (i18n phase 1). A user-visible
 * literal (JSX text, placeholder, title, aria-label, alt, label) in these files
 * fails lint; the list grows as later phases translate more screens (phase 2:
 * agents, projects and tasks, views, settings, runtime hosts and access).
 */
// Copy that is never translated: brand names, keyboard keys, all-caps pixel signage, the "z" sleep cue.
const UNTRANSLATED_WORDS = ["[0-9!-/:-@[-`{-~\s·↑↓↵⌘→—–…]+", "[A-Z_ ·-]+", "Emperor Claw", "EmperorClaw", "Esc", "Ctrl", "Enter", "v", "z( z)*"];
// Two or more letters, except a bare domain name ("emperorclaw.com").
const LETTERS = /^(?![a-z0-9.-]+\.[a-z]{2,}$)[\s\S]*[A-Za-z]{2,}/;
const USER_FACING_ATTRIBUTE = "JSXAttribute[name.name=/^(placeholder|title|aria-label|alt|label)$/]";
const LITERAL_COPY = "Use a message from messages/en.json (useTranslations) instead of a literal string.";
// Literals that render as copy: in an accessible-name/hint attribute, or straight from a JSX
// expression ({x ? "On" : "Off"}, {`Hi ${name}`}). Calls such as t("key") are not matched.
const COPY_SELECTORS = ["", " > ConditionalExpression", " > LogicalExpression", " > ConditionalExpression > ConditionalExpression"].flatMap((via) => [
  `${USER_FACING_ATTRIBUTE} > JSXExpressionContainer${via} > Literal`,
  `${USER_FACING_ATTRIBUTE} > JSXExpressionContainer${via} > TemplateLiteral > TemplateElement`,
  `JSXElement > JSXExpressionContainer${via} > Literal`,
  `JSXElement > JSXExpressionContainer${via} > TemplateLiteral > TemplateElement`,
]).concat(`${USER_FACING_ATTRIBUTE} > Literal`);
/** A local rule (instead of no-restricted-syntax, so it never replaces another config's restrictions). */
const localI18n = {
  rules: {
    "no-literal-ui-copy": {
      meta: { type: "problem", messages: { literal: LITERAL_COPY }, schema: [] },
      create(context) {
        const check = (node) => {
          const text = node.type === "TemplateElement" ? node.value.raw : node.value;
          if (typeof text === "string" && LETTERS.test(text)) context.report({ node, messageId: "literal" });
        };
        return Object.fromEntries(COPY_SELECTORS.map((selector) => [selector, check]));
      },
    },
  },
};
const TRANSLATED_FILES = [
  "src/app/[(]app[)]/page.tsx",
  "src/app/[(]app[)]/error.tsx",
  "src/app/[(]app[)]/not-found.tsx",
  "src/app/[(]app[)]/loading.tsx",
  "src/app/[(]app[)]/inbox/*.tsx",
  "src/app/[(]app[)]/settings/profile-tab.tsx",
  "src/app/error.tsx",
  "src/app/not-found.tsx",
  "src/components/app-sidebar.tsx",
  "src/components/mobile-tab-bar.tsx",
  "src/components/command-palette.tsx",
  "src/components/notification-bell.tsx",
  "src/components/page-header.tsx",
  "src/components/pause-all-control.tsx",
  "src/components/live-pill.tsx",
  "src/components/update-banner.tsx",
  "src/components/version-banner.tsx",
  "src/components/ui/*.tsx",
  "src/components/team-dashboard/*.tsx",
  // Phase 2: agents, projects and tasks, views, settings, runtime hosts, access.
  "src/app/[(]app[)]/agents/**/*.tsx",
  "src/app/[(]app[)]/projects/**/*.tsx",
  "src/app/[(]app[)]/views/**/*.tsx",
  "src/app/[(]app[)]/settings/**/*.tsx",
  "src/components/update-settings-tab.tsx",
  "src/components/views/*.tsx",
  "src/components/access/*.tsx",
  "src/components/runtime-hosts/*.tsx",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Tooling artifacts that must never gate CI:
    ".claude/**",
    ".data/**",
    "public/**",
    "clawhub/**",
    "integrations/**",
    "scripts/**",
  ]),
  {
    rules: {
      // Legacy debt tracked for cleanup, not a merge blocker: ~330 `any`s
      // predate strict linting. New code should still avoid `any` (warn).
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: TRANSLATED_FILES,
    plugins: { i18next, "local-i18n": localI18n },
    rules: {
      // JSX text.
      "i18next/no-literal-string": ["error", { mode: "jsx-text-only", words: { exclude: UNTRANSLATED_WORDS } }],
      // Accessible names and hints, and literals rendered from a JSX expression ({x ? "On" : "Off"}).
      "local-i18n/no-literal-ui-copy": "error",
    },
  },
  {
    // CommonJS test files and Node scripts legitimately use require().
    files: ["**/*.cjs", "scripts/**", "tests/**"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
