import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPool } from "../src/concurrency.js";

test("mapPool runs at most N tasks concurrently and preserves order", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = [1, 2, 3, 4, 5];
  const out = await mapPool(items, 2, async (n) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
  assert.ok(maxInFlight <= 2);
});
