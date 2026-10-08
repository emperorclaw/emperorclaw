import test from "node:test";
import assert from "node:assert/strict";
import { pricingModelRefs } from "../../src/lib/pricing-model-refs";
import { formatCents } from "../../src/lib/team-scene";
test("pricing resolves known namespaces while retaining exact model priority", () => {
 assert.deepEqual(pricingModelRefs(" openrouter/openai/gpt-4o-mini "), ["openrouter/openai/gpt-4o-mini", "openai/gpt-4o-mini", "gpt-4o-mini"]);
 assert.deepEqual(pricingModelRefs("models/gemini-1.5-flash"), ["models/gemini-1.5-flash", "gemini-1.5-flash"]);
 assert.deepEqual(pricingModelRefs("custom/unknown"), ["custom/unknown"]);
 assert.deepEqual(pricingModelRefs(""), []);
});
test("sub-cent reported spend is not presented as zero", () => {
 assert.equal(formatCents(0.2), "<$0.01");
 assert.equal(formatCents(0), "$0.00");
 assert.equal(formatCents(100), "$1.00");
 assert.equal(formatCents(undefined), null);
});
