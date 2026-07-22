import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchOpenPullRequests, parseRepository } from "./github.mjs";
import { partitionEligiblePullRequests } from "./pr-eligibility.mjs";
import { finishAnalysis } from "./analyzer.mjs";
import { analyzeWithAI, semanticJudgeProvider } from "./ai.mjs";
import { prepareAnalysisPipeline } from "./pipeline.mjs";
import { AI_JUDGMENT_PROTOCOL_VERSION, semanticJudgeRepeatCount } from "./semantic-judge.mjs";
import { DockerCombinedVerifier, loadVerificationProfiles } from "./docker-verifier.mjs";
import { GitMergeTreePreflight } from "./preflight.mjs";
import {
  appendVerificationRecords,
  applyVerificationResults,
  selectVerificationCandidates,
  verificationCaseRecord,
} from "./verification.mjs";

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
  const preflightEngine = options.useVerification && options.repository ? new GitMergeTreePreflight(options.repository) : null;
  const pipeline = await prepareAnalysisPipeline(prs, {
    ...options,
    useMergePreflight: options.useMergePreflight || options.useVerification,
    ...(preflightEngine ? { preflightEngine } : {}),
  });
  const prepared = pipeline.prepared;
  let aiConflicts = [];
  let aiError = null;
  if (options.useAI && (options.aiProvider === "codex" || process.env.SEMANTIC_JUDGE_PROVIDER === "codex" || options.apiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)) {
    try { aiConflicts = await analyzeWithAI(prepared, options); }
    catch (error) { aiError = error.message; }
  }
  let result = {
    ...finishAnalysis(prepared, aiConflicts),
    mode: aiConflicts.length ? "ai+heuristic" : "heuristic",
    aiError,
    analysisProtocol: {
      deterministicRuns: 1,
      aiProtocolVersion: options.useAI ? AI_JUDGMENT_PROTOCOL_VERSION : null,
      aiRepeats: options.useAI ? semanticJudgeRepeatCount(options) : 0,
      unanimityRequired: Boolean(options.useAI),
    },
    preflight: pipeline.preflight,
  };
  if (options.useVerification && options.repository) {
    try {
      const profiles = await loadVerificationProfiles(process.env.VERIFICATION_PROFILE_PATH);
      const candidates = selectVerificationCandidates(prepared, result, { limit: Math.max(1, Math.min(10, Number(options.verificationLimit) || 3)) });
      const verifier = new DockerCombinedVerifier(options.repository, { preflightEngine, profiles });
      const verified = await verifier.verify(prepared, candidates);
      const beforeExecution = result;
      result = applyVerificationResults(result, verified.verifications);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const output = join(ROOT, ".cache", "verification-runs", `${options.repository.replaceAll("/", "__")}-${timestamp}.jsonl`);
      const findings = new Map((beforeExecution.findings || []).map((item) => [[...item.prIds].sort().join(":"), item]));
      const records = verified.verifications.map((verification) => verificationCaseRecord({
        repository: options.repository,
        verification,
        finding: findings.get([...verification.prIds].sort().join(":")),
        metadata: {
          analyzerVersion: "1.0.0",
          promptVersion: options.useAI ? "interaction-hypothesis-v0.5" : null,
          model: options.useAI ? (() => {
            const provider = semanticJudgeProvider(options);
            if (provider === "anthropic") return process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
            if (provider === "codex") return process.env.CODEX_MODEL || "gpt-5.4";
            return process.env.OPENAI_MODEL || "gpt-5.6-terra";
          })() : null,
        },
      }));
      await appendVerificationRecords(output, records);
      result = { ...result, verificationErrors: verified.errors, verificationOutput: records.length ? output : null };
    } catch (error) {
      result = { ...result, verificationError: error.message, verificationErrors: [{ key: "runner", error: error.message }] };
    }
  }
  return result;
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
        combinedVerification: true,
        aiJudgmentProtocol: AI_JUDGMENT_PROTOCOL_VERSION,
        aiRepeats: semanticJudgeRepeatCount(),
        aiProvider: semanticJudgeProvider(),
        model: semanticJudgeProvider() === "anthropic" ? process.env.ANTHROPIC_MODEL || "claude-opus-4-8"
          : semanticJudgeProvider() === "codex" ? process.env.CODEX_MODEL || "gpt-5.4" : process.env.OPENAI_MODEL || "gpt-5.6-terra",
      });
    }
    if (req.method === "POST" && url.pathname === "/api/demo") {
      const prs = JSON.parse(await readFile(DEMO_PATH, "utf8"));
      const input = await body(req);
      return json(res, 200, await analyze(prs, {
        useAI: Boolean(input.useAI),
        aiProvider: input.aiProvider,
        aiRepeats: input.aiRepeats ?? process.env.AI_JUDGE_REPEATS,
        useMergePreflight: false,
      }));
    }
    if (req.method === "POST" && url.pathname === "/api/analyze") {
      const input = await body(req);
      const repository = parseRepository(input.repository);
      const limit = Math.max(2, Math.min(100, Number(input.limit) || 20));
      const useVerification = input.useVerification === true;
      const fetched = await fetchOpenPullRequests(repository, process.env.GITHUB_TOKEN, { limit, includeCiStatus: useVerification });
      const partitioned = useVerification ? partitionEligiblePullRequests(fetched) : { eligible: fetched, excluded: [], summary: null };
      const prs = partitioned.eligible;
      if (prs.length < 2) return json(res, 422, { error: "단독 merge eligibility를 통과한 open PR이 2개 미만입니다.", prEligibility: partitioned.summary });
      const result = await analyze(prs, {
        repository,
        useAI: input.useAI !== false,
        aiProvider: input.aiProvider,
        aiRepeats: input.aiRepeats ?? process.env.AI_JUDGE_REPEATS,
        useMergePreflight: input.useMergePreflight !== false,
        useVerification,
        verificationLimit: input.verificationLimit,
      });
      return json(res, 200, {
        ...result,
        repository,
        ...(useVerification ? { prEligibility: { ...partitioned.summary, excludedPullRequests: partitioned.excluded } } : {}),
      });
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
