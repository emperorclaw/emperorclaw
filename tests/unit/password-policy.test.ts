import { test } from "node:test";
import assert from "node:assert/strict";
import { validNewPassword } from "../../src/lib/password-policy";
test("new passwords enforce the same passphrase length bounds without truncation", () => {
    for (const invalid of [null, {}, "", "a".repeat(14), "a".repeat(129)]) assert.equal(validNewPassword(invalid), false);
    for (const valid of ["a".repeat(15), "a".repeat(128), "a long passphrase with spaces"]) assert.equal(validNewPassword(valid), true);
});

import en from "../../messages/en.json";
import zh from "../../messages/zh-CN.json";
test("the displayed policy states the enforced lower and upper password bounds", () => {
    for (const messages of [en, zh]) {
        assert.ok(messages.account.passwordPolicy.includes("15–128"));
        assert.ok(messages.account.errors.INVALID_PASSWORD_REQUEST.includes("15–128"));
    }
});
