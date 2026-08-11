import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const DEFAULT_OPENCODE_MODEL = "cliproxyapi/gpt-5.6-luna";
const DEFAULT_CLAUDE_MODEL = "gpt-5.6-luna";
const usage = "Usage: node benchmarks/cross-session-agent-suite/create.mjs <new-output-directory> [--opencode-model <id>] [--claude-model <id>]";

const [targetArgument, ...optionArguments] = process.argv.slice(2);
if (!targetArgument || targetArgument.startsWith("--")) throw new Error(usage);

const models = {
  opencode: DEFAULT_OPENCODE_MODEL,
  claude: DEFAULT_CLAUDE_MODEL,
};
const modelOptions = new Map([
  ["--opencode-model", "opencode"],
  ["--claude-model", "claude"],
]);
for (let index = 0; index < optionArguments.length; index += 2) {
  const option = optionArguments[index];
  const model = modelOptions.get(option);
  if (!model) throw new Error(`Unknown option: ${option ?? "<missing>"}\n${usage}`);
  const value = optionArguments[index + 1];
  if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
    throw new Error(`${option} requires a non-empty model id\n${usage}`);
  }
  models[model] = value;
}

const source = resolve(import.meta.dirname);
const target = resolve(targetArgument);
if (existsSync(target)) {
  throw new Error(`Refusing to overwrite existing cross-session suite directory: ${target}`);
}

mkdirSync(target, { recursive: false });
const repository = join(target, "repository");
const hiddenDirectory = join(target, "hidden");
cpSync(join(source, "base"), repository, { recursive: true });
cpSync(join(source, "hidden"), hiddenDirectory, { recursive: true });
writeFileSync(join(repository, ".gitattributes"), "* text eol=lf\n", "utf8");

const fixedGitEnvironment = {
  ...process.env,
  GIT_AUTHOR_DATE: "2026-08-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-08-01T00:00:00Z",
};
execFileSync("git", ["init", "-q"], { cwd: repository, stdio: "pipe" });
execFileSync("git", ["add", "."], { cwd: repository, stdio: "pipe" });
execFileSync(
  "git",
  [
    "-c", "user.name=RepoMind",
    "-c", "user.email=benchmark@repomind.local",
    "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", "cross-session base fixture",
  ],
  { cwd: repository, stdio: "pipe", env: fixedGitEnvironment },
);
const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim();

const replacements = new Map([
  ["__BASE_REPOSITORY__", repository],
  ["__BASE_COMMIT__", baseCommit],
  ["__VERIFY__", join(hiddenDirectory, "verify.mjs")],
  ["__OPENCODE_MODEL__", models.opencode],
  ["__CLAUDE_MODEL__", models.claude],
]);
const replace = (value) => replacements.get(value) ?? value;

function materialize(templateName) {
  const manifest = JSON.parse(readFileSync(join(source, templateName), "utf8"));
  for (const sequence of manifest.sequences) {
    sequence.baseRepository = replace(sequence.baseRepository);
    sequence.baseCommit = replace(sequence.baseCommit);
    for (const stage of sequence.stages) {
      if (stage.runner !== undefined) stage.runner = replace(stage.runner);
      if (stage.model !== undefined) stage.model = replace(stage.model);
      for (const check of [...stage.publicChecks, ...stage.hiddenChecks]) {
        check.command = replace(check.command);
        check.args = check.args.map(replace);
      }
    }
  }
  return manifest;
}

const correctnessManifest = materialize("manifest.correctness.template.json");
const efficiencyManifest = materialize("manifest.efficiency.template.json");
const crossAgentManifest = materialize("manifest.cross-agent.template.json");
const layeredConsumptionManifest = materialize("manifest.layered-consumption.template.json");
const layeredConsumptionSmokeManifest = {
  ...layeredConsumptionManifest,
  name: `${layeredConsumptionManifest.name} (single-sequence smoke)`,
  sequences: layeredConsumptionManifest.sequences.slice(0, 1),
};
const fullManifest = {
  version: 1,
  name: "RepoMind six-sequence cross-session correctness and efficiency suite",
  sequences: [...correctnessManifest.sequences, ...efficiencyManifest.sequences],
  acceptance: {
    minSharedTransferHiddenPassRate: 0.95,
    minTransferHiddenPassRateDelta: 0.15,
    minSharedRecallRate: 1,
    maxIsolatedRecallRate: 0,
    minSharedCommitRate: 1,
  },
};
const manifestPaths = {
  full: join(target, "manifest.json"),
  correctness: join(target, "manifest.correctness.json"),
  efficiency: join(target, "manifest.efficiency.json"),
  crossAgent: join(target, "manifest.cross-agent.json"),
};
const layeredConsumptionManifestPath = join(target, "manifest.layered-consumption.json");
const layeredConsumptionSmokeManifestPath = join(target, "manifest.layered-consumption-smoke.json");
writeFileSync(manifestPaths.full, `${JSON.stringify(fullManifest, null, 2)}\n`, "utf8");
writeFileSync(manifestPaths.correctness, `${JSON.stringify(correctnessManifest, null, 2)}\n`, "utf8");
writeFileSync(manifestPaths.efficiency, `${JSON.stringify(efficiencyManifest, null, 2)}\n`, "utf8");
writeFileSync(manifestPaths.crossAgent, `${JSON.stringify(crossAgentManifest, null, 2)}\n`, "utf8");
writeFileSync(layeredConsumptionManifestPath, `${JSON.stringify(layeredConsumptionManifest, null, 2)}\n`, "utf8");
writeFileSync(layeredConsumptionSmokeManifestPath, `${JSON.stringify(layeredConsumptionSmokeManifest, null, 2)}\n`, "utf8");
writeFileSync(join(target, ".gitignore"), "results-*/\n", "utf8");

console.log(JSON.stringify({
  name: basename(target),
  root: target,
  manifest: manifestPaths.full,
  manifests: manifestPaths,
  layeredConsumptionManifest: layeredConsumptionManifestPath,
  layeredConsumptionSmokeManifest: layeredConsumptionSmokeManifestPath,
  repository,
  baseCommit,
  hiddenDirectory,
  models,
}, null, 2));
