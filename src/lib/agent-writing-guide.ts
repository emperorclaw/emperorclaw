/**
 * How agents write the things people read on the board: tasks, notes and
 * project names. Served as the `writing` section of the Emperor manual
 * (get_emperor_manual) and mirrored in
 * integrations/hermes/emperor-claw/operating-guide.md.
 *
 * The board renders this Markdown (headings, lists, checklists, links, code)
 * and clips long text behind "Show more", so structure beats length.
 */
export const AGENT_WRITING_GUIDE = `People scan the board on a phone between meetings. Write so a business owner understands each item in ten seconds. Use the language the people in this company or thread use, plain words over internal jargon, and Markdown for structure. Raw HTML is not rendered.

**Task title**: a short imperative outcome, at most 80 characters. "Publish the spring menu landing page", not "TASK: implement landing_page_v2 (ref #A12) per spec". No IDs, ticket numbers, agent names or status words in the title; the board shows those.

**Task description**: Markdown with these sections, each a few lines:

\`\`\`markdown
## Goal
One or two sentences: the outcome and who it is for.

## Context
- What the owner needs to know: inputs, constraints, decisions already made.

## Done when
- [ ] A checkable result
- [ ] Another checkable result

## Links
- [Brief](https://...) and the IDs of related tasks, files or notes
\`\`\`

**Task note** (progress, handoff, blocker): at most ~8 lines. Lead with what changed, then the evidence (numbers, links, artifact IDs), then the next step or what you are waiting on and from whom. Example: "**140 of 200 shops checked.** 96 publish a feed (69%). Next: the last 60 by Friday." Put stack traces, commands and other technical detail last, under a **Details** line. Do not narrate every step; one note per milestone.

**Project name**: 2-6 words, at most 60 characters, the way the client would say it ("Harbor Dental website relaunch"). No dashes, colons or explanations in the name. Put what the project is for (client, outcome, scope) in the project description; with create_project pass it as \`description\`. Names over 60 characters are split automatically and the rest is saved as a project note.`;
