import { readFileSync } from "node:fs";
import path from "node:path";
import { findRepositoryRoot } from "./git.js";
import { scanRepository } from "./scan.js";
import { serveArtifacts } from "./server.js";

const HELP = `kansoku - architecture observability for agent-built software

Usage:
  kansoku scan [repository] [--base <revision>] [--output <directory>]
  kansoku serve [artifact-directory] [--port <number>]
  kansoku export [artifact-directory]
  kansoku help

Examples:
  kansoku scan . --base HEAD~1
  kansoku serve .kansoku/runs/latest
  kansoku export .kansoku/runs/latest
`;

function parseArguments(args, valueFlags) {
  const positionals = [];
  const flags = new Map();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (!valueFlags.has(argument)) throw new Error(`Unknown option: ${argument}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    flags.set(argument, value);
    index += 1;
  }

  return { positionals, flags };
}

function printScanSummary(result) {
  const summary = result.manifest.summary;
  process.stdout.write(
    [
      `Analyzed ${result.manifest.repository.name}`,
      `  modules: ${summary.targetModules}`,
      `  module edges: ${summary.targetModuleEdges}`,
      `  packages: ${summary.targetPackages}`,
      `  changed modules: +${summary.addedModules} ~${summary.modifiedModules} -${summary.removedModules}`,
      `  changed edges: +${summary.addedEdges} -${summary.removedEdges}`,
      `  impact candidates: ${summary.impactCandidates}`,
      `  findings: ${summary.findings}`,
      `  unresolved internal imports: ${summary.unresolvedImports}`,
      `Artifacts: ${result.outputDirectory}`,
      "",
    ].join("\n"),
  );
}

async function scan(args) {
  const { positionals, flags } = parseArguments(args, new Set(["--base", "--output"]));
  if (positionals.length > 1) throw new Error("scan accepts at most one repository path");
  const repositoryPath = path.resolve(positionals[0] ?? ".");
  const repositoryRoot = findRepositoryRoot(repositoryPath);
  const outputDirectory = path.resolve(flags.get("--output") ?? path.join(repositoryRoot, ".kansoku", "runs", "latest"));
  const result = scanRepository({
    repositoryPath,
    baseRevision: flags.get("--base") ?? "HEAD",
    outputDirectory,
  });
  printScanSummary(result);
}

async function serve(args) {
  const { positionals, flags } = parseArguments(args, new Set(["--port"]));
  if (positionals.length > 1) throw new Error("serve accepts at most one artifact directory");
  const artifactDirectory = path.resolve(positionals[0] ?? ".kansoku/runs/latest");
  const rawPort = flags.get("--port") ?? "4173";
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || String(port) !== rawPort) {
    throw new Error(`Invalid port: ${rawPort}`);
  }
  const running = await serveArtifacts({ artifactDirectory, port });
  process.stdout.write(`Kansoku UI: ${running.url}\n`);

  const shutdown = () => running.server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function exportSelection(args) {
  const { positionals } = parseArguments(args, new Set());
  if (positionals.length > 1) throw new Error("export accepts at most one artifact directory");
  const artifactDirectory = path.resolve(positionals[0] ?? ".kansoku/runs/latest");
  const document = JSON.parse(readFileSync(path.join(artifactDirectory, "selection.json"), "utf8"));
  if (!document.selection) throw new Error("No selection has been saved");
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}

export async function main(args) {
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "scan") return scan(rest);
  if (command === "serve") return serve(rest);
  if (command === "export") return exportSelection(rest);
  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}
