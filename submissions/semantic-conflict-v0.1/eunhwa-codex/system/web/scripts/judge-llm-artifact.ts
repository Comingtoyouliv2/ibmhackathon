import fs from "node:fs";
import type { AnalysisResult, IntentCard } from "../app/lib/analyzer.ts";
import {
  cardFacts,
  generateLlmCandidates,
  judgePairWithLlm,
  LLM_PROMPT_VERSION,
  type LlmProvider,
  type PrLlmContext,
} from "../app/lib/llm-judge.ts";

type ScanResult = AnalysisResult & {
  repository: string;
  llmJudgeProgress?: {
    model: string;
    promptVersion: string;
    startedAt: string;
    processedPairs: string[];
    noConflict: number;
  };
};

type ScanArtifact = { results: ScanResult[]; [key: string]: unknown };
type GitHubFile = { filename: string; patch?: string; status?: string };

const [source] = process.argv.slice(2);
if (!source) throw new Error("Usage: judge-llm-artifact <artifact.json>");
const provider = (process.env.LLM_PROVIDER ?? "openai") as LlmProvider;
if (provider !== "openai" && provider !== "gemini") throw new Error("LLM_PROVIDER must be openai or gemini");
const apiKey = provider === "gemini" ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;
if (!apiKey) throw new Error(`${provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY"} is required`);
if (!githubToken) throw new Error("GITHUB_TOKEN is required to load current PR evidence");

const model = provider === "gemini"
  ? process.env.GEMINI_MODEL ?? "gemini-3.5-flash"
  : process.env.OPENAI_MODEL ?? "gpt-5.6-luna";
const judgeId = `${provider}:${model}`;
// Keep an explicit cost ceiling even when the caller forgets to configure one.
// Candidates are already ranked by semantic score before this cap is applied.
const maxPairs = process.env.LLM_MAX_PAIRS ? Number(process.env.LLM_MAX_PAIRS) : 100;
const concurrency = Math.max(1, Number(process.env.LLM_CONCURRENCY ?? 5));
const force = process.env.FORCE_LLM_JUDGE === "1";
const keepProgress = process.env.LLM_KEEP_PROGRESS === "1";
const artifact = JSON.parse(fs.readFileSync(source, "utf8")) as ScanArtifact;

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function github<T>(url: string): Promise<T> {
  let lastError = "GitHub request failed";
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (response.ok) return response.json() as Promise<T>;
    lastError = `GitHub API ${response.status}: ${(await response.text()).slice(0, 500)}`;
    if (![403, 408, 429, 500, 502, 503, 504].includes(response.status)) break;
    const resetAt = Number(response.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    const rateDelay = resetAt > Date.now() ? resetAt - Date.now() + 1_000 : 0;
    await sleep(Math.max(rateDelay, Math.min(8_000, 500 * 2 ** attempt)));
  }
  throw new Error(lastError);
}

async function fetchContext(repository: string, card: IntentCard): Promise<PrLlmContext> {
  const root = `https://api.github.com/repos/${repository}`;
  const pr = await github<{ title: string; body: string | null; head: { sha: string } }>(`${root}/pulls/${card.pr}`);
  if (card.headSha && pr.head.sha !== card.headSha) throw new Error("PR head changed after pair verification");
  const files: GitHubFile[] = [];
  for (let page = 1; ; page++) {
    const batch = await github<GitHubFile[]>(`${root}/pulls/${card.pr}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return {
    pr: card.pr,
    title: pr.title.slice(0, 500),
    body: (pr.body ?? "").slice(0, 8_000),
    files: files.map((file) => ({ path: file.filename, patch: (file.patch ?? `[${file.status ?? "changed"} binary or patch unavailable]`).slice(0, 16_000) })),
    facts: cardFacts(card),
  };
}

function boundedContext(context: PrLlmContext, sharedResources: string[]): PrLlmContext {
  const sharedFiles = new Set(sharedResources.flatMap((resource) => {
    if (resource.startsWith("file:")) return [resource.slice(5)];
    if (resource.startsWith("surface:") || resource.startsWith("api:")) {
      const moduleId = resource.slice(resource.indexOf(":") + 1).split("#", 1)[0];
      return context.files.flatMap((file) => file.path.replace(/\.(?:d\.)?(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|cs|c|cc|cpp|swift)$/i, "") === moduleId ? [file.path] : []);
    }
    return [];
  }));
  const relevant = context.files.filter((file) => sharedFiles.has(file.path));
  const selected = (relevant.length > 0 ? relevant : context.files.slice(0, 8));
  let remaining = 36_000;
  const files = selected.flatMap((file) => {
    if (remaining <= 0) return [];
    const patch = file.patch.slice(0, Math.min(remaining, 16_000));
    remaining -= patch.length;
    return [{ path: file.path, patch }];
  });
  return { ...context, files, facts: context.facts.slice(0, 40) };
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function checkpoint() {
  fs.writeFileSync(source, JSON.stringify(artifact, null, 2));
}

for (const result of artifact.results) {
  const allCandidates = generateLlmCandidates(result);
  const candidates = allCandidates.slice(0, maxPairs);
  const progressMismatch = result.llmJudgeProgress?.model !== judgeId || result.llmJudgeProgress.promptVersion !== LLM_PROMPT_VERSION;
  if (force || (progressMismatch && !keepProgress)) {
    result.llmFindings = [];
    result.llmJudgeErrors = [];
    result.llmJudgeProgress = {
      model: judgeId,
      promptVersion: LLM_PROMPT_VERSION,
      startedAt: new Date().toISOString(),
      processedPairs: [],
      noConflict: 0,
    };
  }
  if (!result.llmJudgeProgress) {
    result.llmJudgeProgress = {
      model: judgeId,
      promptVersion: LLM_PROMPT_VERSION,
      startedAt: new Date().toISOString(),
      processedPairs: [],
      noConflict: 0,
    };
  }
  const progress = result.llmJudgeProgress;
  if (progressMismatch && keepProgress) {
    const judges = new Set(progress.model.split(" + "));
    judges.add(judgeId);
    progress.model = [...judges].join(" + ");
  }
  const processed = new Set(progress.processedPairs);
  const pending = candidates.filter((candidate) => !processed.has(pairKey(candidate.a, candidate.b)));
  if (pending.length === 0 && result.llmJudgeSummary?.candidatePairs === candidates.length) {
    console.log(`Skipping judged ${result.repository}`);
    continue;
  }

  const cards = new Map(result.cards.map((card) => [card.pr, card]));
  const neededPrs = [...new Set(pending.flatMap((candidate) => [candidate.a, candidate.b]))];
  console.log(`${result.repository}: loading evidence for ${neededPrs.length} PRs / ${pending.length} pairs`);
  const contextRows = await mapConcurrent(neededPrs, 5, async (pr) => {
    const card = cards.get(pr);
    if (!card) return { pr, error: "Semantic intent card missing" } as const;
    try {
      return { pr, context: await fetchContext(result.repository, card) } as const;
    } catch (error) {
      return { pr, error: error instanceof Error ? error.message : String(error) } as const;
    }
  });
  const contexts = new Map(contextRows.flatMap((row) => "context" in row ? [[row.pr, row.context] as const] : []));
  const contextErrors = new Map(contextRows.flatMap((row) => "error" in row ? [[row.pr, row.error] as const] : []));
  result.llmJudgeErrors = result.llmJudgeErrors ?? [];
  result.llmFindings = result.llmFindings ?? [];

  for (let offset = 0; offset < pending.length; offset += concurrency) {
    const batch = pending.slice(offset, offset + concurrency);
    const outcomes = await Promise.all(batch.map(async (candidate) => {
      const a = contexts.get(candidate.a);
      const b = contexts.get(candidate.b);
      if (!a || !b) return { candidate, error: contextErrors.get(candidate.a) ?? contextErrors.get(candidate.b) ?? "PR evidence missing" } as const;
      try {
        const outcome = await judgePairWithLlm(
          candidate,
          boundedContext(a, candidate.sharedResources),
          boundedContext(b, candidate.sharedResources),
          { apiKey, model, provider, confirm: true },
        );
        return { candidate, outcome } as const;
      } catch (error) {
        return { candidate, error: error instanceof Error ? error.message : String(error) } as const;
      }
    }));

    for (const row of outcomes) {
      const key = pairKey(row.candidate.a, row.candidate.b);
      result.llmJudgeErrors = result.llmJudgeErrors.filter((error) => pairKey(error.a, error.b) !== key);
      if ("error" in row) {
        result.llmJudgeErrors.push({ a: row.candidate.a, b: row.candidate.b, reason: row.error });
        continue;
      }
      result.llmFindings = result.llmFindings.filter((finding) => pairKey(finding.a, finding.b) !== key);
      if (row.outcome.finding) result.llmFindings.push(row.outcome.finding);
      if (row.outcome.noConflict) progress.noConflict++;
      processed.add(key);
      progress.processedPairs.push(key);
    }
    const judged = processed.size;
    if (judged % 25 < concurrency || offset + concurrency >= pending.length) {
      const conflicts = result.llmFindings.filter((finding) => finding.verdict === "llm_conflict").length;
      console.log(`  ${result.repository}: ${judged}/${candidates.length} judged, ${conflicts} confirmed risks, ${result.llmJudgeErrors.length} errors`);
      checkpoint();
    }
  }

  result.llmFindings.sort((left, right) => left.a - right.a || left.b - right.b);
  result.llmJudgeSummary = {
    model: progress.model,
    promptVersion: LLM_PROMPT_VERSION,
    candidatePairs: candidates.length,
    judgedPairs: processed.size,
    conflicts: result.llmFindings.filter((finding) => finding.verdict === "llm_conflict").length,
    uncertain: result.llmFindings.filter((finding) => finding.verdict === "llm_uncertain").length,
    noConflict: progress.noConflict,
    errors: result.llmJudgeErrors.length,
    startedAt: progress.startedAt,
    finishedAt: new Date().toISOString(),
  };
  checkpoint();
}

console.log(`LLM semantic judgment complete → ${source}`);
