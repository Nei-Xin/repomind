import assert from "node:assert/strict";
import test from "node:test";
import { runDeliveryJob } from "../src/delivery-worker.js";

test("concurrent callers distinguish the delivery owner from a duplicate", async () => {
  const job = { id: "contract-delivery", attempt: 2 };
  const retries = [];
  let calls = 0;
  let releaseOwner;
  const ownerBlocked = new Promise((resolve) => { releaseOwner = resolve; });

  const delivery = async (id) => {
    assert.equal(id, job.id);
    calls += 1;
    if (calls === 1) {
      await ownerBlocked;
      return true;
    }
    return false;
  };

  const owner = runDeliveryJob(job, async () => {}, (retry) => retries.push(retry), delivery);
  const duplicate = runDeliveryJob(job, async () => {}, (retry) => retries.push(retry), delivery);

  assert.equal(calls, 2);
  releaseOwner();

  assert.deepEqual(await Promise.all([owner, duplicate]), [
    { id: job.id, outcome: "sent" },
    { id: job.id, outcome: "duplicate" },
  ]);
  assert.deepEqual(retries, []);
});

test("a rejected delivery keeps the same id retryable", async () => {
  const job = { id: "contract-retry", attempt: 3, payload: "preserved" };
  const retries = [];
  let calls = 0;

  const delivery = async (id) => {
    assert.equal(id, job.id);
    calls += 1;
    if (calls === 1) throw new Error("temporary failure");
    return true;
  };

  await assert.rejects(
    runDeliveryJob(job, async () => {}, (retry) => retries.push(retry), delivery),
    /temporary failure/,
  );

  assert.deepEqual(retries, [
    { id: job.id, attempt: 4, payload: "preserved" },
  ]);

  assert.deepEqual(
    await runDeliveryJob(retries[0], async () => {}, () => assert.fail("unexpected retry"), delivery),
    { id: job.id, outcome: "sent" },
  );
  assert.equal(calls, 2);
});
