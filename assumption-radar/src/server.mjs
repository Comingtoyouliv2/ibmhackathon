import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchOpenPullRequests, parseRepository } from "./github.mjs";
import { finishAnalysis } from "./analyzer.mjs";
import { analyzeWithAI, semanticJudgeProvider } from "./ai.mjs";
import { prepareAnalysisPipeline } from "./pipeline.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PUBLIC = join(ROOT, "public");
const DEMO_PATH = join(ROOT, "demo", "synthetic-prs.json");
const PORT = Number(process.env.PORT || 4317);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("요청이 너무 큽니다.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function analyze(prs, options = {}) {
  if (!Array.isArray(prs) || prs.length < 2) throw new Error("분석하려면 open PR이 2개 이상 필요합니다.");
  const pipeline = await prepareAnalysisPipeline(prs, options);
  const prepared = pipeline.prepared;
  let aiConflicts = [];
  let aiError = null;
  if (options.useAI && (options.aiProvider === "codex" || process.env.SEMANTIC_JUDGE_PROVIDER === "codex" || options.apiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)) {
    try { aiConflicts = await analyzeWithAI(prepared, options); }
    catch (error) { aiError = error.message; }
  }
  return { ...finishAnalysis(prepared, aiConflicts), mode: aiConflicts.length ? "ai+heuristic" : "heuristic", aiError, preflight: pipeline.preflight };
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/status") {
      return json(res, 200, {
        githubConfigured: Boolean(process.env.GITHUB_TOKEN),
        openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
        anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
        mergeTreePreflight: true,
        aiProvider: semanticJudgeProvider(),
        model: semanticJudgeProvider() === "anthropic" ? process.env.ANTHROPIC_MODEL || "claude-opus-4-8"
          : semanticJudgeProvider() === "codex" ? process.env.CODEX_MODEL || "gpt-5.4" : process.env.OPENAI_MODEL || "gpt-5.6-terra",
      });
    }
    if (req.method === "POST" && url.pathname === "/api/demo") {
      const prs = JSON.parse(await readFile(DEMO_PATH, "utf8"));
      const input = await body(req);
      return json(res, 200, await analyze(prs, { useAI: Boolean(input.useAI), aiProvider: input.aiProvider, useMergePreflight: false }));
    }
    if (req.method === "POST" && url.pathname === "/api/analyze") {
      const input = await body(req);
      const repository = parseRepository(input.repository);
      const limit = Math.max(2, Math.min(100, Number(input.limit) || 20));
      const prs = await fetchOpenPullRequests(repository, process.env.GITHUB_TOKEN, { limit });
      const result = await analyze(prs, { repository, useAI: input.useAI !== false, aiProvider: input.aiProvider, useMergePreflight: input.useMergePreflight !== false });
      return json(res, 200, { ...result, repository });
    }
    if (req.method !== "GET") return json(res, 404, { error: "Not found" });
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
    const target = join(PUBLIC, safe);
    if (!target.startsWith(PUBLIC)) return json(res, 403, { error: "Forbidden" });
    const data = await readFile(target);
    res.writeHead(200, { "Content-Type": MIME[extname(target)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT") return json(res, 404, { error: "Not found" });
    console.error(error);
    return json(res, error.status && error.status < 500 ? error.status : 500, { error: error.message || "분석 중 오류가 발생했습니다." });
  }
}

export const server = http.createServer(handler);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, "127.0.0.1", () => console.log(`Assumption Radar → http://127.0.0.1:${PORT}`));
}
