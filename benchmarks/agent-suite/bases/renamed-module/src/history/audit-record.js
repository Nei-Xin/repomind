export function serializeAuditRecord(record) {
  return JSON.stringify({ event: record.event, actor: record.actor ?? "system" });
}
