import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findRepositoryRoot, getHeadRevision, readRevisionFiles, readWorkingTreeFiles, resolveRevision } from "./git.js";
import { analyzeTypeScriptSnapshot, isAnalysisInput } from "./typescript-analyzer.js";

const SCHEMA_VERSION = "0.1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprintFiles(files) {
  const hash = createHash("sha256");
  for (const [projectPath, content] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(projectPath);
    hash.update("\0");
    hash.update(sha256(content));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function indexById(values) {
  return new Map(values.map((value) => [value.id, value]));
}

function compareSnapshots(base, target) {
  const baseNodes = indexById(base.nodes);
  const targetNodes = indexById(target.nodes);
  const addedNodes = [];
  const removedNodes = [];
  const modifiedNodes = [];

  for (const [id, node] of targetNodes) {
    const before = baseNodes.get(id);
    if (!before) addedNodes.push(id);
    else if (before.contentHash !== node.contentHash) modifiedNodes.push(id);
  }
  for (const id of baseNodes.keys()) {
    if (!targetNodes.has(id)) removedNodes.push(id);
  }

  const baseEdges = indexById(base.edges);
  const targetEdges = indexById(target.edges);
  const addedEdges = [...targetEdges.keys()].filter((id) => !baseEdges.has(id));
  const removedEdges = [...baseEdges.keys()].filter((id) => !targetEdges.has(id));

  const basePackageEdges = indexById(base.packageEdges);
  const targetPackageEdges = indexById(target.packageEdges);
  const addedPackageEdges = [...targetPackageEdges.keys()].filter((id) => !basePackageEdges.has(id));
  const removedPackageEdges = [...basePackageEdges.keys()].filter((id) => !targetPackageEdges.has(id));

  return {
    nodes: {
      added: addedNodes.sort(),
      removed: removedNodes.sort(),
      modified: modifiedNodes.sort(),
    },
    edges: {
      added: addedEdges.sort(),
      removed: removedEdges.sort(),
    },
    packageEdges: {
      added: addedPackageEdges.sort(),
      removed: removedPackageEdges.sort(),
    },
  };
}

function computeImpactCandidates(target, changes) {
  const reverseEdges = new Map();
  for (const edge of target.edges) {
    const dependents = reverseEdges.get(edge.to) ?? [];
    dependents.push(edge.from);
    reverseEdges.set(edge.to, dependents);
  }
  for (const dependents of reverseEdges.values()) dependents.sort();

  const roots = [...changes.nodes.added, ...changes.nodes.modified].sort();
  const result = new Map();
  const queue = roots.map((nodeId) => ({ nodeId, distance: 0, rootId: nodeId }));

  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    const current = result.get(item.nodeId);
    if (current && current.distance <= item.distance) continue;
    result.set(item.nodeId, item);
    for (const dependent of reverseEdges.get(item.nodeId) ?? []) {
      queue.push({ nodeId: dependent, distance: item.distance + 1, rootId: item.rootId });
    }
  }

  return [...result.values()].sort(
    (left, right) => left.distance - right.distance || left.nodeId.localeCompare(right.nodeId),
  );
}

function buildFindings(base, target, changes) {
  const baseEdges = indexById(base.edges);
  const targetEdges = indexById(target.edges);
  const targetNodes = indexById(target.nodes);
  const targetPackages = indexById(target.packages);
  const groups = new Map();

  for (const edgeId of changes.edges.added) {
    if (baseEdges.has(edgeId)) continue;
    const edge = targetEdges.get(edgeId);
    if (!edge) continue;
    const fromNode = targetNodes.get(edge.from);
    const toNode = targetNodes.get(edge.to);
    if (!fromNode?.packageId || !toNode?.packageId || fromNode.packageId === toNode.packageId) continue;
    const key = `${fromNode.packageId}\0${toNode.packageId}`;
    const group = groups.get(key) ?? {
      fromPackageId: fromNode.packageId,
      toPackageId: toNode.packageId,
      edgeIds: [],
      evidenceIds: [],
    };
    group.edgeIds.push(edge.id);
    group.evidenceIds.push(...edge.evidenceIds);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const fromPackage = targetPackages.get(group.fromPackageId);
      const toPackage = targetPackages.get(group.toPackageId);
      return {
        id: `finding:new-cross-package-reference:${group.fromPackageId}->${group.toPackageId}`,
        category: "new-cross-package-reference",
        title: `New references from ${fromPackage?.name ?? group.fromPackageId} to ${toPackage?.name ?? group.toPackageId}`,
        summary: "A module reference now crosses a workspace package boundary. Review whether the dependency direction is intentional.",
        relatedNodeIds: [...new Set(group.edgeIds.flatMap((id) => {
          const edge = targetEdges.get(id);
          return edge ? [edge.from, edge.to] : [];
        }))].sort(),
        relatedEdgeIds: group.edgeIds.sort(),
        evidenceIds: [...new Set(group.evidenceIds)].sort(),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function graphSnapshot(analysis) {
  return {
    analyzer: analysis.analyzer,
    nodes: analysis.nodes,
    edges: analysis.edges,
    packages: analysis.packages,
    packageEdges: analysis.packageEdges,
    unresolvedImports: analysis.unresolvedImports,
    externalImportCount: analysis.externalImportCount,
    diagnostics: analysis.diagnostics,
  };
}

function writeJson(outputDirectory, filename, value) {
  writeFileSync(path.join(outputDirectory, filename), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function scanRepository({ repositoryPath, baseRevision, outputDirectory }) {
  const repositoryRoot = findRepositoryRoot(repositoryPath);
  const baseCommit = resolveRevision(repositoryRoot, baseRevision);
  const targetHead = getHeadRevision(repositoryRoot);
  const baseFiles = readRevisionFiles(repositoryRoot, baseCommit, isAnalysisInput);
  const targetFiles = readWorkingTreeFiles(repositoryRoot, isAnalysisInput);
  const base = analyzeTypeScriptSnapshot(baseFiles, "base");
  const target = analyzeTypeScriptSnapshot(targetFiles, "target");
  const changes = compareSnapshots(base, target);
  const impactCandidates = computeImpactCandidates(target, changes);
  const findings = buildFindings(base, target, changes);
  const resolvedOutput = path.resolve(outputDirectory);

  mkdirSync(resolvedOutput, { recursive: true });

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    repository: {
      name: path.basename(repositoryRoot),
    },
    base: {
      requestedRevision: baseRevision,
      commit: baseCommit,
      fingerprint: fingerprintFiles(baseFiles),
    },
    target: {
      kind: "working-tree",
      headCommit: targetHead,
      fingerprint: fingerprintFiles(targetFiles),
    },
    analyzer: target.analyzer,
    summary: {
      baseModules: base.nodes.length,
      targetModules: target.nodes.length,
      targetModuleEdges: target.edges.length,
      targetPackages: target.packages.length,
      addedModules: changes.nodes.added.length,
      removedModules: changes.nodes.removed.length,
      modifiedModules: changes.nodes.modified.length,
      addedEdges: changes.edges.added.length,
      removedEdges: changes.edges.removed.length,
      findings: findings.length,
      impactCandidates: impactCandidates.length,
      unresolvedImports: target.unresolvedImports.length,
    },
  };

  writeJson(resolvedOutput, "manifest.json", manifest);
  writeJson(resolvedOutput, "graph.json", {
    schemaVersion: SCHEMA_VERSION,
    base: graphSnapshot(base),
    target: graphSnapshot(target),
  });
  writeJson(resolvedOutput, "changes.json", {
    schemaVersion: SCHEMA_VERSION,
    ...changes,
    impactCandidates,
  });
  writeJson(resolvedOutput, "findings.json", {
    schemaVersion: SCHEMA_VERSION,
    findings,
  });
  writeJson(resolvedOutput, "evidence.json", {
    schemaVersion: SCHEMA_VERSION,
    evidence: [...base.evidence, ...target.evidence],
  });
  writeJson(resolvedOutput, "selection.json", {
    schemaVersion: SCHEMA_VERSION,
    selection: null,
  });
  writeJson(resolvedOutput, "local.json", {
    repositoryRoot,
    generatedAt: new Date().toISOString(),
  });

  return {
    outputDirectory: resolvedOutput,
    manifest,
  };
}
