import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const MAX_GIT_OUTPUT = 256 * 1024 * 1024;

function runGit(repositoryRoot, args, options = {}) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: options.encoding,
    input: options.input,
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

export function findRepositoryRoot(inputPath) {
  const root = runGit(path.resolve(inputPath), ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  return realpathSync(root);
}

export function resolveRevision(repositoryRoot, revision) {
  return runGit(repositoryRoot, ["rev-parse", "--verify", `${revision}^{commit}`], { encoding: "utf8" }).trim();
}

export function getHeadRevision(repositoryRoot) {
  return resolveRevision(repositoryRoot, "HEAD");
}

function splitNullTerminated(value) {
  return value.split("\0").filter(Boolean);
}

function validateProjectPath(projectPath) {
  if (
    projectPath.length === 0 ||
    path.posix.isAbsolute(projectPath) ||
    path.posix.normalize(projectPath) !== projectPath ||
    projectPath === ".." ||
    projectPath.startsWith("../")
  ) {
    throw new Error(`Unsafe project-relative path: ${projectPath}`);
  }
}

function resolveWorkingPath(repositoryRoot, projectPath) {
  validateProjectPath(projectPath);
  const candidate = path.resolve(repositoryRoot, ...projectPath.split("/"));
  const prefix = repositoryRoot.endsWith(path.sep) ? repositoryRoot : `${repositoryRoot}${path.sep}`;
  if (candidate !== repositoryRoot && !candidate.startsWith(prefix)) {
    throw new Error(`Path escapes repository root: ${projectPath}`);
  }
  return candidate;
}

export function readWorkingTreeFiles(repositoryRoot, predicate) {
  const output = runGit(repositoryRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  });
  const files = new Map();

  for (const projectPath of splitNullTerminated(output).sort()) {
    if (!predicate(projectPath)) continue;

    const absolutePath = resolveWorkingPath(repositoryRoot, projectPath);
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;

    const realPath = realpathSync(absolutePath);
    const prefix = repositoryRoot.endsWith(path.sep) ? repositoryRoot : `${repositoryRoot}${path.sep}`;
    if (realPath !== repositoryRoot && !realPath.startsWith(prefix)) {
      throw new Error(`Tracked file resolves outside repository root: ${projectPath}`);
    }
    files.set(projectPath, readFileSync(realPath, "utf8"));
  }

  return files;
}

function listRevisionEntries(repositoryRoot, revision, predicate) {
  const output = runGit(repositoryRoot, ["ls-tree", "-r", "-z", "--full-tree", revision], { encoding: "utf8" });
  const entries = [];

  for (const record of splitNullTerminated(output)) {
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode, type, objectId] = record.slice(0, tab).split(" ");
    const projectPath = record.slice(tab + 1);
    if (type !== "blob" || mode === "120000" || !predicate(projectPath)) continue;
    validateProjectPath(projectPath);
    entries.push({ objectId, projectPath });
  }

  return entries.sort((left, right) => left.projectPath.localeCompare(right.projectPath));
}

function readBlobs(repositoryRoot, entries) {
  if (entries.length === 0) return [];
  const input = `${entries.map((entry) => entry.objectId).join("\n")}\n`;
  const output = runGit(repositoryRoot, ["cat-file", "--batch"], { input });
  const values = [];
  let offset = 0;

  for (const entry of entries) {
    const lineEnd = output.indexOf(10, offset);
    if (lineEnd === -1) throw new Error(`Invalid git cat-file response for ${entry.projectPath}`);
    const header = output.subarray(offset, lineEnd).toString("utf8");
    const match = header.match(/^([0-9a-f]+) blob (\d+)$/);
    if (!match) throw new Error(`Cannot read ${entry.projectPath} at revision: ${header}`);
    const size = Number.parseInt(match[2], 10);
    const contentStart = lineEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.length || output[contentEnd] !== 10) {
      throw new Error(`Truncated git object for ${entry.projectPath}`);
    }
    values.push(output.subarray(contentStart, contentEnd).toString("utf8"));
    offset = contentEnd + 1;
  }

  return values;
}

export function readRevisionFiles(repositoryRoot, revision, predicate) {
  const entries = listRevisionEntries(repositoryRoot, revision, predicate);
  const contents = readBlobs(repositoryRoot, entries);
  return new Map(entries.map((entry, index) => [entry.projectPath, contents[index]]));
}

export function readSource(repositoryRoot, snapshot, revision, projectPath) {
  validateProjectPath(projectPath);
  if (snapshot === "base") {
    return runGit(repositoryRoot, ["show", `${revision}:${projectPath}`], { encoding: "utf8" });
  }
  if (snapshot !== "target") throw new Error(`Unknown snapshot: ${snapshot}`);

  const absolutePath = resolveWorkingPath(repositoryRoot, projectPath);
  const stat = lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Source is not a regular file: ${projectPath}`);
  const realPath = realpathSync(absolutePath);
  const prefix = repositoryRoot.endsWith(path.sep) ? repositoryRoot : `${repositoryRoot}${path.sep}`;
  if (realPath !== repositoryRoot && !realPath.startsWith(prefix)) {
    throw new Error(`Source resolves outside repository root: ${projectPath}`);
  }
  return readFileSync(realPath, "utf8");
}
