import type { RepositoryContext } from "../repository.js";

export const UNKNOWN_COMMAND_VERIFICATION = "This command's verification source is unknown; its historical verified label does not establish observed execution. Re-run it before relying on the result.";

/** Legacy verified labels lack provenance. Keep their data, but do not promote
 * them into derived context or present them as independently verified. */
export function unverifiedLegacyCommandIds(context: RepositoryContext, memoryId?: string): Set<string> {
  const rows = context.database.raw.prepare(`
    SELECT m.id FROM memories m
    WHERE m.repository_id=? AND m.type='command'
      ${memoryId === undefined ? "" : "AND m.id=?"}
      AND EXISTS (SELECT 1 FROM json_each(m.tags_json) WHERE value='verified-command')
      AND NOT EXISTS (
        SELECT 1 FROM memory_evidence me JOIN evidence e ON e.id=me.evidence_id
        WHERE me.memory_id=m.id AND e.repository_id=m.repository_id AND e.kind='test_result'
          AND json_extract(e.metadata_json, '$.exitCode')=0
          AND json_extract(e.metadata_json, '$.verificationSource') IN ('tool-observed','host-verified')
      )
  `).all(context.marker.projectId, ...(memoryId === undefined ? [] : [memoryId])) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}
