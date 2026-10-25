import assert from "node:assert/strict";
import test from "node:test";
import { placeMenu } from "../../src/lib/menu-position";

const viewport = { width: 1280, height: 800 };
const trigger = (top: number, left = 100, width = 240) => ({ top, bottom: top + 40, left, width });

test("opens below the trigger when the menu fits there", () => {
    const pos = placeMenu({ trigger: trigger(100), menuHeight: 330, viewport });
    assert.equal(pos.placement, "below");
    assert.equal(pos.top, 148);
    assert.equal(pos.bottom, undefined);
    assert.equal(pos.left, 100);
    assert.equal(pos.width, 240);
    assert.equal(pos.maxHeight, 800 - 140 - 8 - 8);
});

test("flips above when there is no room below and more room above", () => {
    const pos = placeMenu({ trigger: trigger(600), menuHeight: 330, viewport });
    assert.equal(pos.placement, "above");
    assert.equal(pos.top, undefined);
    assert.equal(pos.bottom, 800 - 600 + 8);
    assert.equal(pos.maxHeight, 600 - 8 - 8);
});

test("stays below, capped, when neither side fits and below has more room", () => {
    const pos = placeMenu({ trigger: trigger(300), menuHeight: 900, viewport });
    assert.equal(pos.placement, "below");
    assert.equal(pos.maxHeight, 800 - 340 - 16);
});

test("matches the trigger width and keeps the menu inside the viewport", () => {
    const right = placeMenu({ trigger: trigger(100, 1200, 240), menuHeight: 200, viewport });
    assert.equal(right.width, 240);
    assert.equal(right.left, 1280 - 8 - 240);

    const left = placeMenu({ trigger: trigger(100, -50, 240), menuHeight: 200, viewport });
    assert.equal(left.left, 8);

    const narrow = placeMenu({ trigger: trigger(100, 0, 600), menuHeight: 200, viewport: { width: 375, height: 812 } });
    assert.equal(narrow.width, 375 - 16);
    assert.equal(narrow.left, 8);
});

test("never returns a negative max height", () => {
    const pos = placeMenu({ trigger: { top: -100, bottom: -60, left: 0, width: 200 }, menuHeight: 300, viewport: { width: 400, height: 50 } });
    assert.ok(pos.maxHeight >= 0);
});
