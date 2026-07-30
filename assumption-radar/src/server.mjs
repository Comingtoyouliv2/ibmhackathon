import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchOpenPullRequests, parseRepository } from "./github.mjs";
import { partitionEligiblePullRequests } from "./pr-eligibility.mjs";
import { finishAnalysis } from "./analyzer.mjs";
import { analyzeWithAI, semanticJudgeProvider } from "./ai.mjs";
import { runBobJudgment } from "./bob.mjs";
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

function aiRuntimeStatus() {
  const provider = semanticJudgeProvider();
  if (provider === "bob") return {
    provider,
    configured: Boolean(process.env.BOBSHELL_API_KEY && (!process.env.VERCEL || process.env.BOB_RUNNER_URL)),
    model: "IBM Bob",
    reasoningEffort: null,
    runner: process.env.BOB_RUNNER_URL ? "remote" : process.env.VERCEL ? "unavailable" : "local",
  };
  if (provider === "anthropic") return {
    provider,
    configured: Boolean(process.env.ANTHROPIC_API_KEY),
    model: process.env.ANTHROPIC_MODEL || "claude-opus-4-8",
    reasoningEffort: null,
  };
  if (provider === "codex") return {
    provider,
    configured: true,
    model: process.env.CODEX_MODEL || "gpt-5.4",
    reasoningEffort: process.env.CODEX_REASONING_EFFORT || "medium",
  };
  return {
    provider,
    configured: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_MODEL || "gpt-5.6-terra",
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT || "medium",
  };
}

function aiCredentialAvailable(options = {}) {
  const provider = semanticJudgeProvider(options);
  if (provider === "codex") return true;
  if (provider === "bob") {
    const keyAvailable = Boolean(options.apiKey || process.env.BOBSHELL_API_KEY);
    const runtimeAvailable = !process.env.VERCEL || Boolean(options.runnerUrl || process.env.BOB_RUNNER_URL);
    return keyAvailable && runtimeAvailable;
  }
  if (provider === "anthropic") return Boolean(options.apiKey || process.env.ANTHROPIC_API_KEY);
  return Boolean(options.apiKey || process.env.OPENAI_API_KEY);
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("The request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function bearerToken(req) {
  const value = String(req.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

async function analyze(prs, options = {}) {
  if (!Array.isArray(prs) || prs.length < 2) throw new Error("At least two open PRs are required for analysis.");
  const preflightEngine = options.useVerification && options.repository ? new GitMergeTreePreflight(options.repository) : null;
  const pipeline = await prepareAnalysisPipeline(prs, {
    ...options,
    useMergePreflight: options.useMergePreflight || options.useVerification,
    ...(preflightEngine ? { preflightEngine } : {}),
  });
  const prepared = pipeline.prepared;
  let aiConflicts = [];
  let aiError = null;
  if (options.useAI && aiCredentialAvailable(options)) {
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
            if (provider === "bob") return "IBM Bob";
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

export async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/status") {
      const ai = aiRuntimeStatus();
      return json(res, 200, {
        githubConfigured: Boolean(process.env.GITHUB_TOKEN),
        openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
        anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
        bobConfigured: Boolean(process.env.BOBSHELL_API_KEY),
        mergeTreePreflight: true,
        combinedVerification: true,
        aiJudgmentProtocol: AI_JUDGMENT_PROTOCOL_VERSION,
        aiRepeats: semanticJudgeRepeatCount(),
        aiConfigured: ai.configured,
        aiProvider: ai.provider,
        model: ai.model,
        reasoningEffort: ai.reasoningEffort,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/demo") {
      const prs = JSON.parse(await readFile(DEMO_PATH, "utf8"));
      const input = await body(req);
      return json(res, 200, await analyze(prs, {
        useAI: Boolean(input.useAI),
        aiProvider: input.aiProvider,
        apiKey: input.aiProvider === "bob" ? String(input.bobApiKey || "").trim() : undefined,
        aiRepeats: input.aiRepeats ?? process.env.AI_JUDGE_REPEATS,
        useMergePreflight: false,
      }));
    }
    if (req.method === "POST" && url.pathname === "/api/bob-judge") {
      const gatewayToken = process.env.MERGEGUARD_GATEWAY_TOKEN;
      if (!gatewayToken) return json(res, 404, { error: "Not found" });
      if (!sameSecret(bearerToken(req), gatewayToken)) return json(res, 401, { error: "Unauthorized" });
      const input = await body(req);
      const prompt = String(input.prompt || "");
      const apiKey = String(input.apiKey || "");
      if (!prompt || prompt.length > 900_000) return json(res, 422, { error: "A valid Bob prompt is required." });
      if (!apiKey || apiKey.length > 4_096) return json(res, 422, { error: "A valid IBM Bob API key is required." });
      const judgment = await runBobJudgment({
        prompt,
        apiKey,
        bobBin: process.env.BOB_BIN || "bob",
        cwd: ROOT,
        timeoutMs: Number(process.env.BOB_TIMEOUT_MS || 12 * 60 * 1_000),
      });
      return json(res, 200, { judgment });
    }
    if (req.method === "POST" && url.pathname === "/api/analyze") {
      const input = await body(req);
      const repository = parseRepository(input.repository);
      const aiProvider = input.aiProvider || process.env.SEMANTIC_JUDGE_PROVIDER;
      const bobApiKey = aiProvider === "bob" ? String(input.bobApiKey || process.env.BOBSHELL_API_KEY || "").trim() : "";
      if (aiProvider === "bob" && !bobApiKey) return json(res, 422, { error: "Enter an IBM Bob API key." });
      if (aiProvider === "bob" && process.env.VERCEL && !process.env.BOB_RUNNER_URL) {
        return json(res, 503, {
          error: "IBM Bob live analysis needs a Bob runner. Set BOB_RUNNER_URL and BOB_RUNNER_TOKEN in Vercel, or use the verified demo cases.",
        });
      }
      if (bobApiKey.length > 4_096) return json(res, 422, { error: "The IBM Bob API key is too long." });
      const limit = Math.max(2, Math.min(100, Number(input.limit) || 20));
      const useVerification = input.useVerification === true;
      const fetched = await fetchOpenPullRequests(repository, process.env.GITHUB_TOKEN, { limit, includeCiStatus: useVerification });
      const partitioned = useVerification ? partitionEligiblePullRequests(fetched) : { eligible: fetched, excluded: [], summary: null };
      const prs = partitioned.eligible;
      if (prs.length < 2) return json(res, 422, { error: "Fewer than two open PRs passed individual merge eligibility.", prEligibility: partitioned.summary });
      const result = await analyze(prs, {
        repository,
        useAI: input.useAI !== false,
        aiProvider,
        apiKey: bobApiKey || undefined,
        runnerUrl: process.env.BOB_RUNNER_URL,
        runnerToken: process.env.BOB_RUNNER_TOKEN,
        aiRepeats: input.aiRepeats ?? (aiProvider === "bob" ? 1 : process.env.AI_JUDGE_REPEATS),
        primaryLimit: aiProvider === "bob" ? 8 : undefined,
        secondLookLimit: aiProvider === "bob" ? 4 : undefined,
        contractDiscoveryLimit: aiProvider === "bob" ? 2 : undefined,
        concurrency: aiProvider === "bob" ? 1 : undefined,
        useMergePreflight: process.env.VERCEL ? false : input.useMergePreflight !== false,
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
    return json(res, error.status && error.status < 500 ? error.status : 500, { error: error.message || "An error occurred during analysis." });
  }
}

export const server = http.createServer(handler);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, "127.0.0.1", () => console.log(`Assumption Radar → http://127.0.0.1:${PORT}`));
}
