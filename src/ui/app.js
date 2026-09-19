const state = {
  manifest: null,
  graph: null,
  changes: null,
  findings: null,
  evidence: null,
  selectedPackageId: null,
  selectedModuleId: null,
  selection: null,
};

const elements = {
  repositoryName: document.querySelector("#repository-name"),
  revisionSummary: document.querySelector("#revision-summary"),
  loadStatus: document.querySelector("#load-status"),
  summary: document.querySelector("#summary"),
  packageGraph: document.querySelector("#package-graph"),
  packageList: document.querySelector("#package-list"),
  moduleHeading: document.querySelector("#module-heading"),
  moduleSearch: document.querySelector("#module-search"),
  moduleList: document.querySelector("#module-list"),
  detail: document.querySelector("#detail"),
  changes: document.querySelector("#changes"),
  findings: document.querySelector("#findings"),
  selectionTarget: document.querySelector("#selection-target"),
  requestedOutcome: document.querySelector("#requested-outcome"),
  saveSelection: document.querySelector("#save-selection"),
  selectionStatus: document.querySelector("#selection-status"),
  sourcePanel: document.querySelector("#source-panel"),
  sourceHeading: document.querySelector("#source-heading"),
  sourceCode: document.querySelector("#source-code"),
  closeSource: document.querySelector("#close-source"),
};

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `Request failed: ${response.status}`);
  return value;
}

function clear(element) {
  element.replaceChildren();
}

function text(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

function button(label, className, onClick) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  if (className) element.className = className;
  element.addEventListener("click", onClick);
  return element;
}

function shortRevision(revision) {
  return revision.slice(0, 10);
}

function changeStatus(nodeId) {
  if (state.changes.nodes.added.includes(nodeId)) return "added";
  if (state.changes.nodes.modified.includes(nodeId)) return "modified";
  if (state.changes.nodes.removed.includes(nodeId)) return "removed";
  return "unchanged";
}

function renderSummary() {
  const summary = state.manifest.summary;
  const cards = [
    ["Modules", summary.targetModules, ""],
    ["Module edges", summary.targetModuleEdges, ""],
    ["Packages", summary.targetPackages, ""],
    ["Changed modules", summary.addedModules + summary.modifiedModules + summary.removedModules, "changed"],
    ["Changed edges", summary.addedEdges + summary.removedEdges, "changed"],
    ["Impact candidates", summary.impactCandidates, "changed"],
    ["Findings", summary.findings, "finding"],
  ];
  clear(elements.summary);
  for (const [label, value, className] of cards) {
    const card = document.createElement("article");
    card.className = `summary-card ${className}`.trim();
    card.append(text("span", label, "muted"), text("strong", String(value)));
    elements.summary.append(card);
  }
}

function packageById(packageId) {
  return state.graph.target.packages.find((candidate) => candidate.id === packageId);
}

function moduleById(moduleId) {
  return state.graph.target.nodes.find((candidate) => candidate.id === moduleId);
}

function packageHasChanges(packageId) {
  return state.graph.target.nodes.some((node) => node.packageId === packageId && changeStatus(node.id) !== "unchanged");
}

function selectPackage(packageId) {
  state.selectedPackageId = packageId;
  state.selectedModuleId = null;
  renderPackageGraph();
  renderPackageList();
  renderModules();
  elements.detail.className = "empty-state";
  elements.detail.textContent = "Select a module to inspect its dependencies and source.";
}

function renderPackageList() {
  clear(elements.packageList);
  for (const item of state.graph.target.packages) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `list-item${item.id === state.selectedPackageId ? " selected" : ""}`;
    row.append(text("strong", item.name), text("span", `${item.moduleCount} modules · ${item.root}`));
    row.addEventListener("click", () => selectPackage(item.id));
    elements.packageList.append(row);
  }
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function renderPackageGraph() {
  const svg = elements.packageGraph;
  clear(svg);
  const width = 1200;
  const height = 440;
  const nodeWidth = 176;
  const nodeHeight = 46;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const packages = state.graph.target.packages;
  const positions = new Map();
  const radiusX = Math.min(475, 60 + packages.length * 27);
  const radiusY = 165;
  packages.forEach((item, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(packages.length, 1);
    positions.set(item.id, {
      x: width / 2 + Math.cos(angle) * radiusX,
      y: height / 2 + Math.sin(angle) * radiusY,
    });
  });

  const changedPackageEdges = new Set([
    ...state.changes.packageEdges.added,
    ...state.changes.packageEdges.removed,
  ]);
  for (const edge of state.graph.target.packageEdges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const line = svgElement("line", {
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      "stroke-width": Math.min(6, 0.8 + Math.log2(edge.moduleEdgeCount + 1)),
    });
    line.classList.add("graph-edge");
    if (changedPackageEdges.has(edge.id)) line.classList.add("changed");
    const title = svgElement("title");
    title.textContent = `${packageById(edge.from)?.name} → ${packageById(edge.to)?.name}: ${edge.moduleEdgeCount} module references`;
    line.append(title);
    svg.append(line);
  }

  for (const item of packages) {
    const position = positions.get(item.id);
    const group = svgElement("g", {
      transform: `translate(${position.x - nodeWidth / 2} ${position.y - nodeHeight / 2})`,
      tabindex: "0",
      role: "button",
    });
    group.classList.add("graph-node");
    if (item.id === state.selectedPackageId) group.classList.add("selected");
    if (packageHasChanges(item.id)) group.classList.add("changed");
    const rect = svgElement("rect", { width: nodeWidth, height: nodeHeight, rx: 7 });
    const name = svgElement("text", { x: 10, y: 19 });
    name.textContent = item.name.length > 25 ? `${item.name.slice(0, 23)}…` : item.name;
    const count = svgElement("text", { x: 10, y: 35 });
    count.classList.add("count");
    count.textContent = `${item.moduleCount} modules`;
    group.append(rect, name, count);
    group.addEventListener("click", () => selectPackage(item.id));
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") selectPackage(item.id);
    });
    svg.append(group);
  }
}

function impactDistance(moduleId) {
  return state.changes.impactCandidates.find((item) => item.nodeId === moduleId)?.distance;
}

function renderModules() {
  const selectedPackage = packageById(state.selectedPackageId);
  elements.moduleHeading.textContent = selectedPackage?.name ?? "Select a package";
  clear(elements.moduleList);

  if (!selectedPackage) {
    elements.moduleList.className = "module-list empty-state";
    elements.moduleList.textContent = "Select a package in the graph or sidebar.";
    return;
  }

  elements.moduleList.className = "module-list";
  const query = elements.moduleSearch.value.trim().toLowerCase();
  const modules = state.graph.target.nodes
    .filter((node) => node.packageId === selectedPackage.id && node.path.toLowerCase().includes(query))
    .sort((left, right) => {
      const statusOrder = { added: 0, modified: 1, unchanged: 2, removed: 3 };
      return statusOrder[changeStatus(left.id)] - statusOrder[changeStatus(right.id)] || left.path.localeCompare(right.path);
    });

  for (const module of modules) {
    const status = changeStatus(module.id);
    const row = document.createElement("button");
    row.type = "button";
    row.className = `module-row${module.id === state.selectedModuleId ? " selected" : ""}`;
    row.append(
      text("span", status, `change-badge ${status}`),
      text("code", module.path),
      text("span", impactDistance(module.id) === undefined ? "" : `d${impactDistance(module.id)}`, "impact-distance"),
    );
    row.addEventListener("click", () => selectModule(module.id));
    elements.moduleList.append(row);
  }

  if (modules.length === 0) elements.moduleList.append(text("p", "No matching modules.", "empty-state"));
}

function edgeEvidence(edge) {
  const evidenceById = new Map(state.evidence.evidence.map((item) => [item.id, item]));
  return edge.evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean);
}

function setSelection(selection, label) {
  state.selection = selection;
  elements.selectionTarget.textContent = label;
  elements.saveSelection.disabled = false;
  elements.selectionStatus.textContent = "";
}

function relationButton(edge, direction) {
  const relatedId = direction === "outgoing" ? edge.to : edge.from;
  const related = moduleById(relatedId);
  const evidence = edgeEvidence(edge)[0];
  const label = `${direction === "outgoing" ? "→" : "←"} ${related?.path ?? relatedId}${evidence ? `:${evidence.source.line}` : ""}`;
  return button(label, "relation", () => {
    if (!related) return;
    selectPackage(related.packageId);
    selectModule(related.id);
    if (evidence) loadSource(evidence.source.path, evidence.source.line);
  });
}

function selectModule(moduleId) {
  const module = moduleById(moduleId);
  if (!module) return;
  state.selectedModuleId = moduleId;
  state.selectedPackageId = module.packageId;
  renderPackageGraph();
  renderPackageList();
  renderModules();

  const outgoing = state.graph.target.edges.filter((edge) => edge.from === moduleId);
  const incoming = state.graph.target.edges.filter((edge) => edge.to === moduleId);
  elements.detail.className = "";
  clear(elements.detail);

  const identity = document.createElement("div");
  identity.className = "detail-block";
  identity.append(text("h3", "Module"), text("p", module.path, "detail-path"));
  identity.append(button("View target source", "secondary", () => loadSource(module.path)));
  elements.detail.append(identity);

  for (const [heading, edges, direction] of [
    ["Outgoing references", outgoing, "outgoing"],
    ["Incoming references", incoming, "incoming"],
  ]) {
    const block = document.createElement("div");
    block.className = "detail-block";
    block.append(text("h3", `${heading} (${edges.length})`));
    for (const edge of edges.slice(0, 30)) block.append(relationButton(edge, direction));
    if (edges.length === 0) block.append(text("p", "None", "muted"));
    if (edges.length > 30) block.append(text("p", `${edges.length - 30} more`, "muted"));
    elements.detail.append(block);
  }

  const firstEvidence = outgoing.flatMap(edgeEvidence)[0];
  setSelection(
    {
      findingId: null,
      targets: [{ path: module.path, ...(firstEvidence ? { line: firstEvidence.source.line } : {}) }],
      evidenceIds: firstEvidence ? [firstEvidence.id] : [],
    },
    module.path,
  );
}

function renderChanges() {
  clear(elements.changes);
  const groups = [
    ["added", state.changes.nodes.added],
    ["modified", state.changes.nodes.modified],
    ["removed", state.changes.nodes.removed],
  ];
  let rendered = 0;
  for (const [status, ids] of groups) {
    for (const id of ids.slice(0, 20)) {
      const module = moduleById(id) ?? state.graph.base.nodes.find((candidate) => candidate.id === id);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "list-item";
      row.append(text("strong", module?.path ?? id), text("span", status, `change-badge ${status}`));
      if (moduleById(id)) row.addEventListener("click", () => selectModule(id));
      elements.changes.append(row);
      rendered += 1;
    }
  }
  if (rendered === 0) elements.changes.append(text("p", "No structural module changes.", "empty-state"));
}

function selectFinding(finding) {
  const targets = finding.relatedNodeIds
    .map(moduleById)
    .filter(Boolean)
    .map((module) => ({ path: module.path }));
  setSelection(
    {
      findingId: finding.id,
      targets,
      evidenceIds: finding.evidenceIds,
    },
    finding.title,
  );
  elements.detail.className = "";
  clear(elements.detail);
  elements.detail.append(text("h3", finding.title), text("p", finding.summary, "muted"));
  for (const target of targets) elements.detail.append(button(target.path, "relation", () => selectModule(`module:${target.path}`)));
}

function renderFindings() {
  clear(elements.findings);
  for (const finding of state.findings.findings) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "list-item";
    row.append(text("strong", finding.title), text("span", finding.category));
    row.addEventListener("click", () => selectFinding(finding));
    elements.findings.append(row);
  }
  if (state.findings.findings.length === 0) {
    elements.findings.append(text("p", "No rule-based review candidates in this delta.", "empty-state"));
  }
}

async function loadSource(projectPath, highlightLine) {
  try {
    const source = await fetchJson(`/api/source?snapshot=target&path=${encodeURIComponent(projectPath)}`);
    elements.sourceHeading.textContent = projectPath;
    clear(elements.sourceCode);
    for (const [index, content] of source.content.split("\n").entries()) {
      const line = document.createElement("div");
      line.className = `source-line${index + 1 === highlightLine ? " highlight" : ""}`;
      line.append(text("span", String(index + 1), "line-number"), text("span", content || " ", "line-content"));
      elements.sourceCode.append(line);
    }
    elements.sourcePanel.hidden = false;
    elements.sourcePanel.scrollIntoView({ behavior: "smooth", block: "start" });
    if (highlightLine) elements.sourceCode.children[highlightLine - 1]?.scrollIntoView({ block: "center" });
  } catch (error) {
    elements.selectionStatus.textContent = error instanceof Error ? error.message : String(error);
    elements.selectionStatus.className = "error";
  }
}

async function saveSelection() {
  if (!state.selection) return;
  const requestedOutcome = elements.requestedOutcome.value.trim();
  if (!requestedOutcome) {
    elements.selectionStatus.textContent = "Requested outcome is required.";
    elements.selectionStatus.className = "error";
    return;
  }
  try {
    await fetchJson("/api/selection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...state.selection, requestedOutcome }),
    });
    elements.selectionStatus.textContent = "Saved to selection.json";
    elements.selectionStatus.className = "muted";
  } catch (error) {
    elements.selectionStatus.textContent = error instanceof Error ? error.message : String(error);
    elements.selectionStatus.className = "error";
  }
}

async function initialize() {
  try {
    const [manifest, graph, changes, findings, evidence] = await Promise.all(
      ["manifest.json", "graph.json", "changes.json", "findings.json", "evidence.json"].map((filename) =>
        fetchJson(`/api/artifacts/${filename}`),
      ),
    );
    Object.assign(state, { manifest, graph, changes, findings, evidence });
    elements.repositoryName.textContent = manifest.repository.name;
    elements.revisionSummary.textContent = `${shortRevision(manifest.base.commit)} → working tree at ${shortRevision(manifest.target.headCommit)}`;
    elements.loadStatus.textContent = `schema ${manifest.schemaVersion} · TypeScript ${manifest.analyzer.version}`;
    elements.loadStatus.classList.add("ready");
    renderSummary();
    renderPackageGraph();
    renderPackageList();
    renderModules();
    renderChanges();
    renderFindings();
  } catch (error) {
    elements.loadStatus.textContent = "Failed to load";
    elements.loadStatus.className = "status-pill error";
    elements.detail.className = "error";
    elements.detail.textContent = error instanceof Error ? error.message : String(error);
  }
}

elements.moduleSearch.addEventListener("input", renderModules);
elements.saveSelection.addEventListener("click", saveSelection);
elements.closeSource.addEventListener("click", () => {
  elements.sourcePanel.hidden = true;
});

initialize();
