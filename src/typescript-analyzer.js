import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";

const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts)$/i;
const RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts"];

export function isTypeScriptSource(projectPath) {
  return SOURCE_EXTENSION.test(projectPath);
}

export function isAnalysisInput(projectPath) {
  return isTypeScriptSource(projectPath) || path.posix.basename(projectPath) === "package.json" || projectPath === "tsconfig.json";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function scriptKindFor(projectPath) {
  if (projectPath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (projectPath.endsWith(".mts")) return ts.ScriptKind.TS;
  if (projectPath.endsWith(".cts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.TS;
}

function sourceLocation(sourceFile, node) {
  const start = node.getStart(sourceFile);
  const location = sourceFile.getLineAndCharacterOfPosition(start);
  return {
    path: sourceFile.fileName,
    line: location.line + 1,
    column: location.character + 1,
  };
}

function extractImports(projectPath, content) {
  const sourceFile = ts.createSourceFile(projectPath, content, ts.ScriptTarget.Latest, true, scriptKindFor(projectPath));
  const imports = [];

  function add(moduleSpecifier, node, typeOnly, syntax) {
    if (!ts.isStringLiteralLike(moduleSpecifier)) return;
    imports.push({
      specifier: moduleSpecifier.text,
      location: sourceLocation(sourceFile, moduleSpecifier),
      typeOnly,
      syntax,
      position: node.getStart(sourceFile),
    });
  }

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier, node, node.importClause?.isTypeOnly === true, "import");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node.moduleSpecifier, node, node.isTypeOnly, "export");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      add(node.moduleReference.expression, node, node.isTypeOnly, "import-equals");
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, node, true, "import-type");
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(node.arguments[0], node, false, "dynamic-import");
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        add(node.arguments[0], node, false, "require");
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports.sort((left, right) => left.position - right.position || left.specifier.localeCompare(right.specifier));
}

function parsePackages(files, diagnostics) {
  const packages = [];
  for (const [projectPath, content] of files) {
    if (path.posix.basename(projectPath) !== "package.json") continue;
    try {
      const value = JSON.parse(content);
      if (typeof value.name !== "string" || value.name.length === 0) continue;
      const root = path.posix.dirname(projectPath);
      packages.push({
        id: `package:${root}`,
        name: value.name,
        root,
      });
    } catch (error) {
      diagnostics.push({
        kind: "invalid-package-json",
        path: projectPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return packages.sort((left, right) => right.root.length - left.root.length || left.name.localeCompare(right.name));
}

function packageFor(projectPath, packages) {
  for (const candidate of packages) {
    if (candidate.root === "." || projectPath.startsWith(`${candidate.root}/`)) return candidate;
  }
  return null;
}

function parsePathAliases(files, diagnostics) {
  const content = files.get("tsconfig.json");
  if (content === undefined) return [];
  const parsed = ts.parseConfigFileTextToJson("tsconfig.json", content);
  if (parsed.error) {
    diagnostics.push({
      kind: "invalid-tsconfig",
      path: "tsconfig.json",
      message: ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"),
    });
    return [];
  }

  const compilerOptions = parsed.config?.compilerOptions;
  const paths = compilerOptions?.paths;
  if (!paths || typeof paths !== "object") return [];
  const baseUrl = typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : ".";
  const rules = [];

  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets)) continue;
    const wildcard = pattern.indexOf("*");
    rules.push({
      pattern,
      prefix: wildcard === -1 ? pattern : pattern.slice(0, wildcard),
      suffix: wildcard === -1 ? "" : pattern.slice(wildcard + 1),
      hasWildcard: wildcard !== -1,
      targets: targets.filter((target) => typeof target === "string").map((target) => path.posix.join(baseUrl, target)),
    });
  }

  return rules.sort((left, right) => {
    const leftSpecificity = left.prefix.length + left.suffix.length;
    const rightSpecificity = right.prefix.length + right.suffix.length;
    return rightSpecificity - leftSpecificity || left.pattern.localeCompare(right.pattern);
  });
}

function substituteAlias(rule, specifier) {
  if (!rule.hasWildcard) return specifier === rule.pattern ? "" : null;
  if (!specifier.startsWith(rule.prefix) || !specifier.endsWith(rule.suffix)) return null;
  return specifier.slice(rule.prefix.length, specifier.length - rule.suffix.length);
}

function normalizeCandidate(candidate) {
  const normalized = path.posix.normalize(candidate);
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function resolveCandidate(candidate, sourcePaths) {
  const normalized = normalizeCandidate(candidate);
  if (normalized === null) return null;
  const candidates = [normalized];
  const extension = path.posix.extname(normalized);

  if (extension === ".js") candidates.push(`${normalized.slice(0, -3)}.ts`, `${normalized.slice(0, -3)}.tsx`);
  if (extension === ".mjs") candidates.push(`${normalized.slice(0, -4)}.mts`);
  if (extension === ".cjs") candidates.push(`${normalized.slice(0, -4)}.cts`);
  if (!SOURCE_EXTENSION.test(normalized)) {
    for (const sourceExtension of RESOLUTION_EXTENSIONS) candidates.push(`${normalized}${sourceExtension}`);
    for (const sourceExtension of RESOLUTION_EXTENSIONS) candidates.push(`${normalized}/index${sourceExtension}`);
  }

  return candidates.find((value) => sourcePaths.has(value)) ?? null;
}

function resolveImport(fromPath, specifier, sourcePaths, aliases, packages) {
  if (specifier.startsWith(".")) {
    return {
      kind: "relative",
      path: resolveCandidate(path.posix.join(path.posix.dirname(fromPath), specifier), sourcePaths),
    };
  }

  for (const rule of aliases) {
    const wildcardValue = substituteAlias(rule, specifier);
    if (wildcardValue === null) continue;
    for (const target of rule.targets) {
      const candidate = rule.hasWildcard ? target.replaceAll("*", wildcardValue) : target;
      const resolved = resolveCandidate(candidate, sourcePaths);
      if (resolved !== null) return { kind: "alias", path: resolved };
    }
  }

  const matchingPackage = packages
    .filter((candidate) => specifier === candidate.name || specifier.startsWith(`${candidate.name}/`))
    .sort((left, right) => right.name.length - left.name.length)[0];
  if (matchingPackage) {
    const subpath = specifier === matchingPackage.name ? "index" : specifier.slice(matchingPackage.name.length + 1);
    const withoutDist = subpath.startsWith("dist/") ? subpath.slice("dist/".length) : subpath;
    const resolved = resolveCandidate(path.posix.join(matchingPackage.root, "src", withoutDist), sourcePaths);
    return { kind: "workspace-package", path: resolved };
  }

  return { kind: "external", path: null };
}

function aggregatePackageGraph(nodes, edges, packages) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const moduleCounts = new Map();
  for (const node of nodes) {
    const packageId = node.packageId ?? "package:(unowned)";
    moduleCounts.set(packageId, (moduleCounts.get(packageId) ?? 0) + 1);
  }

  const packageNodes = packages
    .filter((candidate) => moduleCounts.has(candidate.id))
    .map((candidate) => ({ ...candidate, moduleCount: moduleCounts.get(candidate.id) }))
    .sort((left, right) => left.name.localeCompare(right.name));

  if (moduleCounts.has("package:(unowned)")) {
    packageNodes.push({
      id: "package:(unowned)",
      name: "(unowned)",
      root: ".",
      moduleCount: moduleCounts.get("package:(unowned)"),
    });
  }

  const packageEdgesByKey = new Map();
  for (const edge of edges) {
    const fromPackage = nodesById.get(edge.from)?.packageId ?? "package:(unowned)";
    const toPackage = nodesById.get(edge.to)?.packageId ?? "package:(unowned)";
    if (fromPackage === toPackage) continue;
    const key = `${fromPackage}\0${toPackage}`;
    const current = packageEdgesByKey.get(key) ?? {
      id: `package-edge:${fromPackage}->${toPackage}`,
      from: fromPackage,
      to: toPackage,
      moduleEdgeCount: 0,
      evidenceIds: [],
    };
    current.moduleEdgeCount += 1;
    current.evidenceIds.push(...edge.evidenceIds);
    packageEdgesByKey.set(key, current);
  }

  const packageEdges = [...packageEdgesByKey.values()]
    .map((edge) => ({ ...edge, evidenceIds: [...new Set(edge.evidenceIds)].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return { packageNodes, packageEdges };
}

export function analyzeTypeScriptSnapshot(files, snapshotName) {
  const diagnostics = [];
  const packages = parsePackages(files, diagnostics);
  const aliases = parsePathAliases(files, diagnostics);
  const sourceEntries = [...files.entries()].filter(([projectPath]) => isTypeScriptSource(projectPath));
  sourceEntries.sort(([left], [right]) => left.localeCompare(right));
  const sourcePaths = new Set(sourceEntries.map(([projectPath]) => projectPath));

  const nodes = sourceEntries.map(([projectPath, content]) => {
    const owner = packageFor(projectPath, packages);
    return {
      id: `module:${projectPath}`,
      kind: "module",
      name: path.posix.basename(projectPath),
      path: projectPath,
      packageId: owner?.id ?? null,
      contentHash: sha256(content),
    };
  });

  const edgeMap = new Map();
  const evidence = [];
  const unresolvedImports = [];
  let externalImportCount = 0;

  for (const [projectPath, content] of sourceEntries) {
    for (const imported of extractImports(projectPath, content)) {
      const resolved = resolveImport(projectPath, imported.specifier, sourcePaths, aliases, packages);
      if (resolved.path === null) {
        if (resolved.kind === "external") {
          externalImportCount += 1;
        } else {
          unresolvedImports.push({
            path: projectPath,
            line: imported.location.line,
            column: imported.location.column,
            specifier: imported.specifier,
            resolutionKind: resolved.kind,
          });
        }
        continue;
      }

      const evidenceId = `evidence:${sha256(`${snapshotName}\0${projectPath}\0${imported.position}\0${imported.specifier}`).slice(0, 20)}`;
      evidence.push({
        id: evidenceId,
        snapshot: snapshotName,
        kind: "module-reference",
        source: imported.location,
        specifier: imported.specifier,
        syntax: imported.syntax,
        typeOnly: imported.typeOnly,
        resolvedPath: resolved.path,
        resolutionKind: resolved.kind,
      });

      const from = `module:${projectPath}`;
      const to = `module:${resolved.path}`;
      const edgeId = `edge:${from}->${to}`;
      const edge = edgeMap.get(edgeId) ?? {
        id: edgeId,
        kind: "module-reference",
        from,
        to,
        evidenceIds: [],
      };
      edge.evidenceIds.push(evidenceId);
      edgeMap.set(edgeId, edge);
    }
  }

  const edges = [...edgeMap.values()]
    .map((edge) => ({ ...edge, evidenceIds: edge.evidenceIds.sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const packageGraph = aggregatePackageGraph(nodes, edges, packages);

  return {
    analyzer: {
      name: "typescript",
      version: ts.version,
    },
    nodes,
    edges,
    packages: packageGraph.packageNodes,
    packageEdges: packageGraph.packageEdges,
    evidence: evidence.sort((left, right) => left.id.localeCompare(right.id)),
    unresolvedImports: unresolvedImports.sort(
      (left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.specifier.localeCompare(right.specifier),
    ),
    externalImportCount,
    diagnostics,
  };
}
