import { createHash, randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import type {
  ExportSkillCandidateResult,
  RebuildSkillCandidatesInput,
  RebuildSkillCandidatesResult,
  ReviewSkillCandidateInput,
  SkillCandidateAuditEntry,
  SkillCandidateDetails,
  SkillCandidateSessionSource,
  SkillCandidateStatus,
  SkillCandidateSummary,
} from "../domain/types.js";
import { RepoMindError } from "../errors.js";
import type { RepositoryContext } from "../repository.js";
import { redactSecrets } from "../security/redaction.js";

interface EvidenceSource {
  id: string;
  kind: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

interface SuccessfulSession {
  id: string;
  task: string;
  finalHead: string | null;
  startedAt: number;
  endedAt: number;
  evidence: EvidenceSource[];
  steps: string[];
  verification: string[];
  failures: string[];
  signature: string;
}

interface CandidateRow {
  id: string;
  workflow_key: string;
  title: string;
  trigger_text: string;
  inputs_json: string;
  steps_json: string;
  verification_json: string;
  risks_json: string;
  source_fingerprint: string;
  source_session_count: number;
  status: SkillCandidateStatus;
  review_reason: string | null;
  created_at: number;
  updated_at: number;
  reviewed_at: number | null;
}

const DEFAULT_MIN_SESSIONS = 3;
const MAX_MIN_SESSIONS = 20;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function compact(value: string, max = 240): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function redactAbsolutePaths(value: string): { content: string; redactions: number } {
  let redactions = 0;
  const patterns = [
    /\b[A-Za-z]:[\\/][^\s`"'<>]+/gu,
    /(?<![:/A-Za-z0-9._-])\/(?!\/)[^\s`"'<>]+/gu,
  ];
  let content = value;
  for (const pattern of patterns) {
    content = content.replace(pattern, () => {
      redactions++;
      return "[REDACTED:absolute-path]";
    });
  }
  return { content, redactions };
}

function normalizeCommand(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function commandKey(value: string): string {
  return normalizeCommand(value).toLocaleLowerCase("en-US");
}

function uniqueCommands(values: string[]): string[] {
  const commands = new Map<string, string>();
  for (const value of values) {
    const normalized = normalizeCommand(value);
    if (normalized) commands.set(commandKey(normalized), normalized);
  }
  return [...commands.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

function taskLabel(task: string): string {
  const label = redactAbsolutePaths(task).content
    .replace(/\bv?\d+(?:\.\d+){0,3}\b/giu, " ")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return compact(label || task, 80) || "Repeated repository workflow";
}

function commonLabel(sessions: SuccessfulSession[]): string {
  const counts = new Map<string, { count: number; label: string }>();
  for (const session of sessions) {
    const label = taskLabel(session.task);
    const key = label.toLocaleLowerCase("en-US");
    const previous = counts.get(key);
    counts.set(key, { count: (previous?.count ?? 0) + 1, label: previous?.label ?? label });
  }
  return [...counts.values()].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))[0]!.label;
}

function sessionFingerprint(sessions: SuccessfulSession[]): string {
  return sha256(stableJson(sessions.map((session) => ({
    id: session.id,
    task: session.task,
    finalHead: session.finalHead,
    evidence: session.evidence.map((item) => [item.id, item.kind, item.contentHash]),
  }))));
}

function workflowSignature(steps: string[], verification: string[]): string {
  return stableJson({
    steps: steps.map(commandKey).sort(),
    verification: verification.map(commandKey).sort(),
  });
}

function metadataCommand(evidence: EvidenceSource): string | null {
  return typeof evidence.metadata.command === "string"
    ? normalizeCommand(redactAbsolutePaths(evidence.metadata.command).content)
    : null;
}

function metadataExitCode(evidence: EvidenceSource): number | null {
  return typeof evidence.metadata.exitCode === "number" ? evidence.metadata.exitCode : null;
}

function failedCommandDescription(evidence: EvidenceSource): string | null {
  const command = metadataCommand(evidence);
  if (!command || metadataExitCode(evidence) === 0) return null;
  return `Observed failure: ${compact(command, 160)} (exit ${String(metadataExitCode(evidence))}).`;
}

function slug(value: string): string {
  const ascii = value.normalize("NFKD").replace(/[^a-zA-Z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").toLowerCase();
  return (ascii || "repomind-workflow").slice(0, 64).replace(/-+$/u, "");
}

function markdown(candidate: SkillCandidateDetails): string {
  const lines = [
    "---",
    `name: ${slug(candidate.title.replace(/^Workflow:\s*/u, ""))}`,
    `description: ${JSON.stringify(candidate.trigger)}`,
    "---",
    "",
    `# ${candidate.title.replace(/^Workflow:\s*/u, "")}`,
    "",
    "## Inputs",
    ...candidate.inputs.map((item) => `- ${item}`),
    "",
    "## Steps",
    ...candidate.steps.map((item, index) => `${index + 1}. Run \`${item.replaceAll("`", "\\`")}\`.`),
    "",
    "## Verification",
    ...candidate.verification.map((item) => `- Run \`${item.replaceAll("`", "\\`")}\` and require exit code 0.`),
    "",
    "## Risks",
    ...candidate.risks.map((item) => `- ${item}`),
    "",
    "## Provenance",
    `- RepoMind candidate: ${candidate.id}`,
    `- Independent successful sessions: ${candidate.sourceSessionCount}`,
    ...candidate.sources.map((source) => `- ${source.sessionId} (${source.evidenceIds.length} Evidence records)`),
    "",
  ];
  return lines.join("\n");
}

export class SkillCandidateStore {
  constructor(private readonly context: RepositoryContext) {}

  rebuild(input: RebuildSkillCandidatesInput = {}): RebuildSkillCandidatesResult {
    const minSessions = input.minSessions ?? DEFAULT_MIN_SESSIONS;
    if (!Number.isInteger(minSessions) || minSessions < DEFAULT_MIN_SESSIONS || minSessions > MAX_MIN_SESSIONS) {
      throw new RepoMindError("INVALID_INPUT", `minSessions must be an integer from ${DEFAULT_MIN_SESSIONS} to ${MAX_MIN_SESSIONS}`);
    }
    const groups = new Map<string, SuccessfulSession[]>();
    for (const session of this.successfulSessions()) {
      if (!session.steps.length && !session.verification.length) continue;
      groups.set(session.signature, [...(groups.get(session.signature) ?? []), session]);
    }
    const qualifying = [...groups.entries()]
      .filter(([, sessions]) => sessions.length >= minSessions)
      .sort(([left], [right]) => left.localeCompare(right));
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const touched: string[] = [];
    const db = this.context.database.raw;
    this.context.database.transaction(() => {
      for (const [signature, sessions] of qualifying) {
        const workflowKey = sha256(signature);
        const previous = db.prepare("SELECT * FROM skill_candidates WHERE repository_id=? AND workflow_key=?")
          .get(this.context.marker.projectId, workflowKey) as CandidateRow | undefined;
        const fingerprint = sessionFingerprint(sessions);
        if (previous?.source_fingerprint === fingerprint) {
          unchanged++;
          touched.push(previous.id);
          continue;
        }
        const id = previous?.id ?? `l4_${randomUUID()}`;
        const now = Date.now();
        const label = commonLabel(sessions);
        const steps = sessions[0]!.steps.length ? sessions[0]!.steps : sessions[0]!.verification;
        const verification = sessions[0]!.verification.length ? sessions[0]!.verification : sessions[0]!.steps;
        const risks = [...new Set([
          "Review repository state and command side effects before running this candidate.",
          ...sessions.flatMap((session) => session.failures),
        ])];
        const values = {
          title: `Workflow: ${label}`,
          trigger: `Use when a repository task matches: ${label}.`,
          inputs: ["A clean or intentionally dirty repository checkout.", "Task-specific values from the triggering request."],
          steps,
          verification,
          risks,
        };
        if (previous) {
          db.prepare(`
            UPDATE skill_candidates SET title=?, trigger_text=?, inputs_json=?, steps_json=?, verification_json=?,
              risks_json=?, source_fingerprint=?, source_session_count=?, status='pending', review_reason=NULL,
              reviewed_at=NULL, updated_at=? WHERE id=?
          `).run(values.title, values.trigger, JSON.stringify(values.inputs), JSON.stringify(values.steps),
            JSON.stringify(values.verification), JSON.stringify(values.risks), fingerprint, sessions.length, now, id);
          this.audit(id, "sources_changed", previous.status, "pending", "Candidate sources changed and require fresh approval.", {
            previousSourceCount: Number(previous.source_session_count), sourceSessionCount: sessions.length,
          }, now);
          updated++;
        } else {
          db.prepare(`
            INSERT INTO skill_candidates(id, repository_id, workflow_key, title, trigger_text, inputs_json, steps_json,
              verification_json, risks_json, source_fingerprint, source_session_count, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
          `).run(id, this.context.marker.projectId, workflowKey, values.title, values.trigger, JSON.stringify(values.inputs),
            JSON.stringify(values.steps), JSON.stringify(values.verification), JSON.stringify(values.risks), fingerprint,
            sessions.length, now, now);
          this.audit(id, "generated", null, "pending", null, { sourceSessionCount: sessions.length }, now);
          created++;
        }
        db.prepare("DELETE FROM skill_candidate_sessions WHERE candidate_id=?").run(id);
        db.prepare("DELETE FROM skill_candidate_evidence WHERE candidate_id=?").run(id);
        sessions.forEach((session, index) => {
          db.prepare("INSERT INTO skill_candidate_sessions(candidate_id, session_id, sort_order) VALUES (?, ?, ?)")
            .run(id, session.id, index);
          for (const evidence of session.evidence) {
            db.prepare("INSERT OR IGNORE INTO skill_candidate_evidence(candidate_id, evidence_id) VALUES (?, ?)")
              .run(id, evidence.id);
          }
        });
        touched.push(id);
      }
    });
    return { created, updated, unchanged, candidates: this.summariesByIds(touched) };
  }

  list(status?: SkillCandidateStatus): SkillCandidateSummary[] {
    if (status && !(["pending", "approved", "rejected"] as string[]).includes(status)) {
      throw new RepoMindError("INVALID_INPUT", `Invalid skill candidate status ${status}`);
    }
    const params: Array<string> = [this.context.marker.projectId];
    let where = "repository_id=?";
    if (status) {
      where += " AND status=?";
      params.push(status);
    }
    const rows = this.context.database.raw.prepare(`SELECT * FROM skill_candidates WHERE ${where} ORDER BY updated_at DESC, id`)
      .all(...params) as unknown as CandidateRow[];
    return rows.map((row) => this.summary(row));
  }

  inspect(id: string): SkillCandidateDetails {
    const row = this.row(id);
    const db = this.context.database.raw;
    const sourceRows = db.prepare(`
      SELECT s.id, s.task, s.final_head, s.started_at, s.ended_at FROM skill_candidate_sessions cs
      JOIN sessions s ON s.id=cs.session_id WHERE cs.candidate_id=? ORDER BY cs.sort_order
    `).all(id) as Array<{ id: string; task: string; final_head: string | null; started_at: number; ended_at: number }>;
    const evidenceStatement = db.prepare(`
      SELECT e.id FROM skill_candidate_evidence ce JOIN evidence e ON e.id=ce.evidence_id
      WHERE ce.candidate_id=? AND e.session_id=? ORDER BY e.created_at, e.id
    `);
    const sources: SkillCandidateSessionSource[] = sourceRows.map((source) => ({
      sessionId: source.id,
      task: source.task,
      finalHead: source.final_head,
      startedAt: Number(source.started_at),
      endedAt: Number(source.ended_at),
      evidenceIds: (evidenceStatement.all(id, source.id) as Array<{ id: string }>).map((item) => item.id),
    }));
    const audits = db.prepare(`
      SELECT action, previous_status, next_status, reason, metadata_json, created_at
      FROM skill_candidate_audit_log WHERE candidate_id=? ORDER BY created_at, rowid
    `).all(id) as Array<{
      action: SkillCandidateAuditEntry["action"];
      previous_status: SkillCandidateStatus | null;
      next_status: SkillCandidateStatus;
      reason: string | null;
      metadata_json: string;
      created_at: number;
    }>;
    return {
      ...this.summary(row),
      workflowKey: row.workflow_key,
      sourceFingerprint: row.source_fingerprint,
      sources,
      audit: audits.map((entry) => ({
        action: entry.action,
        previousStatus: entry.previous_status,
        nextStatus: entry.next_status,
        reason: entry.reason,
        metadata: parseObject(entry.metadata_json),
        createdAt: Number(entry.created_at),
      })),
    };
  }

  review(input: ReviewSkillCandidateInput): SkillCandidateSummary {
    if (!input.candidateId.trim() || !input.reason.trim()) {
      throw new RepoMindError("INVALID_INPUT", "candidateId and reason must not be empty");
    }
    if (input.action !== "approve" && input.action !== "reject") {
      throw new RepoMindError("INVALID_INPUT", `Invalid skill candidate review action ${String(input.action)}`);
    }
    const previous = this.row(input.candidateId);
    if (previous.status !== "pending") {
      throw new RepoMindError("INVALID_INPUT", `Skill candidate ${input.candidateId} is already ${previous.status}`);
    }
    const nextStatus: SkillCandidateStatus = input.action === "approve" ? "approved" : "rejected";
    const reason = redactSecrets(input.reason).content.trim();
    const now = Date.now();
    this.context.database.transaction(() => {
      this.context.database.raw.prepare(`
        UPDATE skill_candidates SET status=?, review_reason=?, reviewed_at=?, updated_at=? WHERE id=?
      `).run(nextStatus, reason, now, now, input.candidateId);
      this.audit(input.candidateId, nextStatus, previous.status, nextStatus, reason, {}, now);
    });
    return this.summary(this.row(input.candidateId));
  }

  export(id: string, outputPath: string): ExportSkillCandidateResult {
    const candidate = this.inspect(id);
    if (candidate.status !== "approved") {
      throw new RepoMindError("INVALID_INPUT", `Skill candidate ${id} must be approved before export`);
    }
    const output = resolve(outputPath);
    if (extname(output).toLowerCase() !== ".md") throw new RepoMindError("INVALID_INPUT", "Skill candidate output must be a .md file");
    if (existsSync(output)) throw new RepoMindError("INVALID_INPUT", `Refusing to overwrite existing file ${output}`);
    if (!existsSync(dirname(output))) throw new RepoMindError("INVALID_INPUT", `Output directory does not exist: ${dirname(output)}`);
    const pathRedacted = redactAbsolutePaths(markdown(candidate));
    const secretRedacted = redactSecrets(pathRedacted.content);
    const redactions = pathRedacted.redactions + secretRedacted.redactions;
    writeFileSync(output, secretRedacted.content, { encoding: "utf8", flag: "wx" });
    const digest = sha256(secretRedacted.content);
    const now = Date.now();
    try {
      this.context.database.transaction(() => this.audit(id, "exported", "approved", "approved", "Approved candidate exported for external review.", {
        sha256: digest,
        redactions,
        fileName: output.split(/[\\/]/u).at(-1),
      }, now));
    } catch (error) {
      rmSync(output, { force: true });
      throw error;
    }
    return { candidateId: id, path: output, sha256: digest, redactions };
  }

  private successfulSessions(): SuccessfulSession[] {
    const rows = this.context.database.raw.prepare(`
      SELECT s.id, s.task, s.final_head, s.started_at, s.ended_at,
        e.id AS evidence_id, e.kind, e.content_hash, e.metadata_json, e.created_at
      FROM sessions s LEFT JOIN evidence e ON e.session_id=s.id
      WHERE s.repository_id=? AND s.status='committed'
      ORDER BY s.started_at, s.id, e.created_at, e.id
    `).all(this.context.marker.projectId) as Array<{
      id: string; task: string; final_head: string | null; started_at: number; ended_at: number;
      evidence_id: string | null; kind: string | null; content_hash: string | null; metadata_json: string | null; created_at: number | null;
    }>;
    const sessions = new Map<string, SuccessfulSession>();
    for (const row of rows) {
      let session = sessions.get(row.id);
      if (!session) {
        session = {
          id: row.id,
          task: row.task,
          finalHead: row.final_head,
          startedAt: Number(row.started_at),
          endedAt: Number(row.ended_at),
          evidence: [],
          steps: [],
          verification: [],
          failures: [],
          signature: "",
        };
        sessions.set(row.id, session);
      }
      if (row.evidence_id && row.kind && row.content_hash && row.metadata_json && row.created_at !== null) {
        session.evidence.push({
          id: row.evidence_id,
          kind: row.kind,
          contentHash: row.content_hash,
          metadata: parseObject(row.metadata_json),
          createdAt: Number(row.created_at),
        });
      }
    }
    return [...sessions.values()].map((session) => {
      const successfulCommands = session.evidence.filter((item) => item.kind === "command_result" && metadataExitCode(item) === 0)
        .flatMap((item) => metadataCommand(item) ?? []);
      const successfulTests = session.evidence.filter((item) => item.kind === "test_result" && metadataExitCode(item) === 0)
        .flatMap((item) => metadataCommand(item) ?? []);
      session.steps = uniqueCommands(successfulCommands);
      session.verification = uniqueCommands(successfulTests);
      session.failures = session.evidence.flatMap((item) => failedCommandDescription(item) ?? []);
      session.signature = workflowSignature(session.steps, session.verification);
      return session;
    });
  }

  private summariesByIds(ids: string[]): SkillCandidateSummary[] {
    const statement = this.context.database.raw.prepare("SELECT * FROM skill_candidates WHERE id=? AND repository_id=?");
    return ids.flatMap((id) => {
      const row = statement.get(id, this.context.marker.projectId) as CandidateRow | undefined;
      return row ? [this.summary(row)] : [];
    });
  }

  private row(id: string): CandidateRow {
    const row = this.context.database.raw.prepare("SELECT * FROM skill_candidates WHERE id=? AND repository_id=?")
      .get(id, this.context.marker.projectId) as CandidateRow | undefined;
    if (!row) throw new RepoMindError("SKILL_CANDIDATE_NOT_FOUND", `Skill candidate ${id} was not found`);
    return row;
  }

  private summary(row: CandidateRow): SkillCandidateSummary {
    return {
      id: row.id,
      title: row.title,
      trigger: row.trigger_text,
      inputs: JSON.parse(row.inputs_json) as string[],
      steps: JSON.parse(row.steps_json) as string[],
      verification: JSON.parse(row.verification_json) as string[],
      risks: JSON.parse(row.risks_json) as string[],
      sourceSessionCount: Number(row.source_session_count),
      status: row.status,
      reviewReason: row.review_reason,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      reviewedAt: row.reviewed_at === null ? null : Number(row.reviewed_at),
    };
  }

  private audit(
    id: string,
    action: SkillCandidateAuditEntry["action"],
    previous: SkillCandidateStatus | null,
    next: SkillCandidateStatus,
    reason: string | null,
    metadata: Record<string, unknown>,
    now: number,
  ): void {
    this.context.database.raw.prepare(`
      INSERT INTO skill_candidate_audit_log(id, candidate_id, action, previous_status, next_status, reason, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(`aud_${randomUUID()}`, id, action, previous, next, reason, JSON.stringify(metadata), now);
  }
}
