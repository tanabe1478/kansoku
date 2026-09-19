import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTypeScriptSnapshot } from "../src/typescript-analyzer.js";

test("resolves relative and tsconfig path imports with source evidence", () => {
  const files = new Map([
    [
      "package.json",
      JSON.stringify({ name: "fixture", private: true }),
    ],
    [
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@fixture/*": ["src/*.ts"],
          },
        },
      }),
    ],
    ["src/a.ts", 'import { b } from "./b.js";\nexport type { C } from "@fixture/c";\nexport const a = b;\n'],
    ["src/b.ts", "export const b = 1;\n"],
    ["src/c.ts", "export type C = string;\n"],
  ]);

  const result = analyzeTypeScriptSnapshot(files, "target");

  assert.deepEqual(
    result.nodes.map((node) => node.id),
    ["module:src/a.ts", "module:src/b.ts", "module:src/c.ts"],
  );
  assert.deepEqual(
    result.edges.map((edge) => [edge.from, edge.to]),
    [
      ["module:src/a.ts", "module:src/b.ts"],
      ["module:src/a.ts", "module:src/c.ts"],
    ],
  );
  assert.equal(result.evidence.length, 2);
  assert.equal(result.evidence.find((item) => item.resolvedPath === "src/b.ts").source.line, 1);
  assert.equal(result.evidence.find((item) => item.resolvedPath === "src/c.ts").typeOnly, true);
  assert.deepEqual(result.unresolvedImports, []);
});

test("reports unresolved relative imports without treating external imports as failures", () => {
  const files = new Map([
    ["package.json", JSON.stringify({ name: "fixture" })],
    ["src/a.ts", 'import "node:path";\nimport "./missing.js";\n'],
  ]);

  const result = analyzeTypeScriptSnapshot(files, "target");

  assert.equal(result.externalImportCount, 1);
  assert.deepEqual(result.unresolvedImports, [
    {
      path: "src/a.ts",
      line: 2,
      column: 8,
      specifier: "./missing.js",
      resolutionKind: "relative",
    },
  ]);
});
