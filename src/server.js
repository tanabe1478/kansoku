import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSource } from "./git.js";

const UI_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");
const ARTIFACT_FILES = new Set(["manifest.json", "graph.json", "changes.json", "findings.json", "evidence.json", "selection.json"]);
const MAX_REQUEST_BODY = 64 * 1024;

function send(response, status, contentType, body) {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
  });
  response.end(body);
}

function sendJson(response, status, value) {
  send(response, status, "application/json; charset=utf-8", `${JSON.stringify(value)}\n`);
}

function readJson(artifactDirectory, filename) {
  return JSON.parse(readFileSync(path.join(artifactDirectory, filename), "utf8"));
}

async function readRequestJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isSafeProjectPath(projectPath) {
  return (
    projectPath.length > 0 &&
    !path.posix.isAbsolute(projectPath) &&
    path.posix.normalize(projectPath) === projectPath &&
    projectPath !== ".." &&
    !projectPath.startsWith("../")
  );
}

function validateSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Selection must be an object");
  if (typeof value.requestedOutcome !== "string" || value.requestedOutcome.trim().length === 0) {
    throw new Error("requestedOutcome is required");
  }
  if (!Array.isArray(value.targets) || value.targets.length === 0) throw new Error("At least one target is required");
  for (const target of value.targets) {
    if (!target || typeof target !== "object" || typeof target.path !== "string" || !isSafeProjectPath(target.path)) {
      throw new Error("Each target must contain a safe project-relative path");
    }
    if (target.line !== undefined && (!Number.isInteger(target.line) || target.line < 1)) {
      throw new Error("Target line must be a positive integer");
    }
  }
  if (value.findingId !== undefined && typeof value.findingId !== "string") throw new Error("findingId must be a string");
  if (value.evidenceIds !== undefined && (!Array.isArray(value.evidenceIds) || value.evidenceIds.some((id) => typeof id !== "string"))) {
    throw new Error("evidenceIds must be an array of strings");
  }

  return {
    findingId: value.findingId ?? null,
    targets: value.targets.map((target) => ({ path: target.path, ...(target.line === undefined ? {} : { line: target.line }) })),
    evidenceIds: value.evidenceIds ?? [],
    requestedOutcome: value.requestedOutcome.trim(),
  };
}

function staticFile(urlPath) {
  if (urlPath === "/") return { filename: "index.html", contentType: "text/html; charset=utf-8" };
  if (urlPath === "/app.js") return { filename: "app.js", contentType: "text/javascript; charset=utf-8" };
  if (urlPath === "/styles.css") return { filename: "styles.css", contentType: "text/css; charset=utf-8" };
  return null;
}

export async function serveArtifacts({ artifactDirectory, port = 4173, host = "127.0.0.1" }) {
  const resolvedArtifacts = path.resolve(artifactDirectory);
  const manifest = readJson(resolvedArtifacts, "manifest.json");
  const local = readJson(resolvedArtifacts, "local.json");

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);

      if (request.method === "GET" && url.pathname.startsWith("/api/artifacts/")) {
        const filename = url.pathname.slice("/api/artifacts/".length);
        if (!ARTIFACT_FILES.has(filename)) {
          sendJson(response, 404, { error: "Unknown artifact" });
          return;
        }
        send(response, 200, "application/json; charset=utf-8", readFileSync(path.join(resolvedArtifacts, filename), "utf8"));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/source") {
        const snapshot = url.searchParams.get("snapshot") ?? "target";
        const projectPath = url.searchParams.get("path");
        if (!projectPath) {
          sendJson(response, 400, { error: "path is required" });
          return;
        }
        const content = readSource(local.repositoryRoot, snapshot, manifest.base.commit, projectPath);
        sendJson(response, 200, { snapshot, path: projectPath, content });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/selection") {
        const origin = request.headers.origin;
        const expectedOrigin = `http://${request.headers.host}`;
        if (origin && origin !== expectedOrigin) {
          sendJson(response, 403, { error: "Cross-origin selection writes are not allowed" });
          return;
        }
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 415, { error: "Selection writes require application/json" });
          return;
        }
        const selection = validateSelection(await readRequestJson(request));
        const document = { schemaVersion: manifest.schemaVersion, selection };
        writeFileSync(path.join(resolvedArtifacts, "selection.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
        sendJson(response, 200, document);
        return;
      }

      if (request.method === "GET") {
        const asset = staticFile(url.pathname);
        if (asset) {
          send(response, 200, asset.contentType, readFileSync(path.join(UI_DIRECTORY, asset.filename)));
          return;
        }
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 400, { error: message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot determine server address");
  return {
    server,
    url: `http://${host}:${address.port}`,
  };
}
