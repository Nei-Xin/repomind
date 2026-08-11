import { deliverOnce } from "./delivery.js";

export async function runDeliveryJob(job, send, scheduleRetry, deliver = deliverOnce) {
  try {
    const performed = await deliver(job.id, send);
    return { id: job.id, outcome: performed ? "sent" : "duplicate" };
  } catch (error) {
    scheduleRetry({ ...job, id: job.id, attempt: job.attempt + 1 });
    throw error;
  }
}
