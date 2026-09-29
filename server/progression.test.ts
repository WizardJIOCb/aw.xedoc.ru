import { test } from "node:test";
import assert from "node:assert/strict";
import { levelForXp, xpForLevel, nextLevelXp, MAX_XP } from "../src/shared/progression.js";

test("Forever experience transitions match source thresholds, including the 120 cap", () => {
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(99), 1);
  assert.equal(levelForXp(100), 2);
  assert.equal(levelForXp(204), 2);
  assert.equal(levelForXp(205), 3);
  assert.equal(xpForLevel(100), 378302);
  assert.equal(levelForXp(378302), 100);
  assert.equal(nextLevelXp(100), 399419);
  assert.equal(levelForXp(MAX_XP), 120);
  assert.equal(levelForXp(MAX_XP * 2), 120);
  assert.equal(nextLevelXp(120), null);
  for (let level = 2; level <= 120; level++) {
    assert.equal(levelForXp(xpForLevel(level) - 1), level - 1);
    assert.equal(levelForXp(xpForLevel(level)), level);
  }
});
