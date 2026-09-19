import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { scanRepository } from "../src/scan.js";
import { serveArtifacts } from "../src/server.js";

function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

function readJson(directory, filename) {
  return JSON.parse(readFileSync(path.join(directory, filename), "utf8"));
}

test("compares a revision with the working tree and serves artifacts and source", async (context) => {
  const repository = mkdtempSync(path.join(tmpdir(), "kansoku-scan-"));
  const output = path.join(repository, ".kansoku", "runs", "latest");
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Kansoku Test");
  git(repository, "config", "user.email", "kansoku@example.invalid");
  mkdirSync(path.join(repository, "src"));
  writeFileSync(path.join(repository, ".gitignore"), ".kansoku/\n");
  writeFileSync(path.join(repository, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(path.join(repository, "src", "a.ts"), "export const a = 1;\n");
  git(repository, "add", ".gitignore", "package.json", "src/a.ts");
  git(repository, "commit", "-m", "initial");
  const base = git(repository, "rev-parse", "HEAD");

  writeFileSync(path.join(repository, "src", "a.ts"), 'export { b } from "./b.js";\n');
  writeFileSync(path.join(repository, "src", "b.ts"), "export const b = 2;\n");

  const result = scanRepository({ repositoryPath: repository, baseRevision: base, outputDirectory: output });
  const manifest = readJson(output, "manifest.json");
  const changes = readJson(output, "changes.json");
  const graph = readJson(output, "graph.json");

  assert.equal(result.manifest.summary.targetModules, 2);
  assert.deepEqual(changes.nodes.added, ["module:src/b.ts"]);
  assert.deepEqual(changes.nodes.modified, ["module:src/a.ts"]);
  assert.deepEqual(changes.edges.added, ["edge:module:src/a.ts->module:src/b.ts"]);
  assert.equal(graph.target.edges[0].evidenceIds.length, 1);
  assert.equal(manifest.repository.name, path.basename(repository));
  assert.equal("repositoryRoot" in manifest, false);
  assert.equal(readJson(output, "local.json").repositoryRoot, realpathSync(repository));

  const running = await serveArtifacts({ artifactDirectory: output, port: 0 });
  context.after(() => running.server.close());
  const manifestResponse = await fetch(`${running.url}/api/artifacts/manifest.json`);
  assert.equal(manifestResponse.status, 200);
  assert.equal((await manifestResponse.json()).summary.targetModules, 2);
  const sourceResponse = await fetch(`${running.url}/api/source?snapshot=target&path=src%2Fa.ts`);
  assert.equal(sourceResponse.status, 200);
  assert.equal((await sourceResponse.json()).content, 'export { b } from "./b.js";\n');

  const selectionResponse = await fetch(`${running.url}/api/selection`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: running.url,
    },
    body: JSON.stringify({
      targets: [{ path: "src/a.ts", line: 1 }],
      requestedOutcome: "Remove the new dependency.",
    }),
  });
  assert.equal(selectionResponse.status, 200);
  assert.equal(readJson(output, "selection.json").selection.targets[0].path, "src/a.ts");

  const unsafeSelectionResponse = await fetch(`${running.url}/api/selection`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      targets: [{ path: "../outside.ts" }],
      requestedOutcome: "Inspect this file.",
    }),
  });
  assert.equal(unsafeSelectionResponse.status, 400);
});
