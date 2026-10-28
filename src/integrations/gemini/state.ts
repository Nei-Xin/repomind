import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataRoot } from "../../config/paths.js";

// Keep this module lightweight: model hooks run once per streamed chunk.
type ObjectValue = Record<string, unknown>;
const obj = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const str = (value: unknown): string => typeof value === "string" ? value : "";
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const hash = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
interface Turn { start: string; at: number; prompt: string; closed: boolean; unsafe: boolean; model?: { key: string; at: number; complete: boolean } }
interface Pending { key: string; start: string; id: string }
interface State { turn?: Turn; pending: Pending[] }
export interface GeminiReceipt { id: string; event: string; start?: string; previous?: string; toolId?: string; complete?: boolean }
export interface GeminiInput extends ObjectValue { hook_event_name: string; session_id: string; cwd: string; timestamp: string }
export function parseGeminiInput(input: unknown): GeminiInput {
  const value = obj(input);
  for (const key of ["hook_event_name", "session_id", "cwd", "timestamp"]) if (!str(value[key])) throw new Error(`Gemini hook requires ${key}`);
  if (!Number.isFinite(Date.parse(str(value.timestamp)))) throw new Error("Gemini hook requires an ISO timestamp");
  return value as GeminiInput;
}
function transaction<T>(input: GeminiInput, update: (state: State, db: DatabaseSync) => T): T {
  const directory = join(dataRoot(), "gemini-hooks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, `${hash([resolve(input.cwd), input.session_id])}.sqlite`));
  try {
    db.exec("PRAGMA busy_timeout=1500; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, value TEXT NOT NULL); BEGIN IMMEDIATE");
    const row = db.prepare("SELECT value FROM state WHERE id=1").get() as { value: string } | undefined;
    const state: State = row ? JSON.parse(row.value) : { pending: [] };
    const result = update(state, db);
    db.prepare("INSERT OR REPLACE INTO state VALUES (1,?)").run(JSON.stringify(state));
    db.exec("COMMIT");
    return result;
  } finally { db.close(); }
}

/** Persist only hashes, timestamps and correlation IDs, never prompts or model/tool output.
 * SQLite transactions serialize parallel hook subprocesses without holding locks over HTTP.
 * Gemini has no native turn/tool IDs: ambiguous identical concurrent calls are discarded.
 */
export function planGeminiHook(input: GeminiInput): GeminiReceipt {
  return transaction(input, (state, db) => {
    const event = input.hook_event_name;
    const id = `gemini:${event}:${hash(input)}`;
    const empty: GeminiReceipt = { id, event };
    const old = db.prepare("SELECT value FROM receipts WHERE id=?").get(id) as { value: string } | undefined;
    if (old) {
      const receipt: GeminiReceipt = JSON.parse(old.value);
      return receipt.start === state.turn?.start && !state.turn?.closed ? receipt : empty;
    }
    const receipt = { ...empty };
    const at = Date.parse(input.timestamp);
    const turn = state.turn;
    if (event === "BeforeAgent" && str(input.prompt).trim() && (!turn || at > turn.at)) {
      if (turn && !turn.closed) receipt.previous = turn.start;
      receipt.start = id;
      // The persisted turn timestamp rejects older starts after receipt pruning.
      // Keep pending tool signatures: a late result must not match a new call.
      db.exec("DELETE FROM receipts");
      state.turn = { start: id, at, prompt: hash(input.prompt), closed: false, unsafe: !!turn && !turn.closed && turn.prompt === hash(input.prompt) };
    } else if (turn && !turn.closed && at >= turn.at) {
      if (event === "BeforeModel" && (!turn.model || at > turn.model.at)) {
        turn.model = { key: hash(input.llm_request), at, complete: false };
      } else if (event === "AfterModel" && turn.model && at >= turn.model.at && turn.model.key === hash(input.llm_request)) {
        const candidates = obj(input.llm_response).candidates;
        const reasons = (Array.isArray(candidates) ? candidates : []).map(c => str(obj(c).finishReason)).filter(Boolean);
        turn.model.at = at;
        if (reasons.length) turn.model.complete = reasons.every(reason => reason === "STOP");
      } else if (event === "BeforeTool") {
        const key = hash([input.tool_name, input.tool_input]);
        if (turn.model) turn.model.complete = false;
        state.pending.push({ key, start: turn.start, id });
        receipt.start = turn.start;
        receipt.toolId = id;
      } else if (event === "AfterTool") {
        const key = hash([input.tool_name, input.tool_input]);
        const matches = state.pending.filter(item => item.key === key);
        state.pending = state.pending.filter(item => item.key !== key);
        if (matches.length === 1 && matches[0]!.start === turn.start) {
          receipt.start = turn.start;
          receipt.toolId = matches[0]!.id;
        } else { turn.unsafe = true; }
      } else if (event === "AfterAgent" && hash(input.prompt) === turn.prompt) {
        receipt.start = turn.start;
        receipt.complete = !!turn.model?.complete && !turn.unsafe && !state.pending.some(item => item.start === turn.start)
          && !!str(input.prompt_response).trim() && str(input.prompt_response) !== "[no response text]";
      } else if (event === "SessionEnd" || event === "SessionStart") {
        receipt.start = turn.start;
      }
    }
    // Model chunks need no replay receipts: their updates are already idempotent.
    if (state.turn && !state.turn.closed && at >= state.turn.at && event !== "BeforeModel" && event !== "AfterModel") db.prepare("INSERT INTO receipts VALUES (?,?)").run(id, JSON.stringify(receipt));
    return receipt;
  });
}
export function closeGeminiTurn(input: GeminiInput, start: string): void {
  transaction(input, (state, db) => {
    if (state.turn?.start !== start) return;
    state.turn.closed = true;
    // Completed turns need only their high-water mark and unresolved tool keys.
    // Retain the SQLite file so delayed BeforeAgent replays cannot reopen tasks.
    db.exec("DELETE FROM receipts");
  });
}
