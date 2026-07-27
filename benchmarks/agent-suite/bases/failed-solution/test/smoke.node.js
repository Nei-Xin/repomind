import test from "node:test";
import assert from "node:assert/strict";
import { deliverOnce, resetDeliveries } from "../src/delivery.js";
test("a first delivery succeeds", async () => { resetDeliveries(); assert.equal(await deliverOnce("a", async () => {}), true); });
