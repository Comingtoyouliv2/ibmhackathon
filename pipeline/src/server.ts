/** Local web platform for running and inspecting the PR conflict pipeline. */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonl } from './io.js';
import type { CandidatePair, IntentCard, RawPr, ReviewPacket, SectorCard, Step0Result } from './types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const CURRENT_DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'));
const RUNS_DIR = path.resolve(process.env.WEB_RUNS_DIR ?? path.join(ROOT, 'runs'));
const HOST = process.env.PLATFORM_HOST ?? '127.0.0.1';
const PORT = Number(process.env.PLATFORM_PORT ?? 4317);
const LOG_LIMIT = 300;

type RunStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
interface RunState {
  id: string;
  repo: string;
  dataDir: string;
  status: RunStatus;
  stage: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  logs: string[];
  child?: ChildProcess;
}

const jobs = new Map<string, RunState>();
const summaryCache = new Map<string, ReturnType<typeof buildSummary>>();
const queueCache = new Map<string, ReturnType<typeof buildQueueResults>>();
const graphCache = new Map<string, ReturnType<typeof buildGraphResults>>();
const packetCache = new Map<string, ReviewPacket[]>();
const stages = [
  { script: 'fetch', label: 'Collecting open PRs', progress: 8 },
  { script: 'step0', label: 'Running Step 0', progress: 22 },
  { script: 'fetch-diffs', label: 'Fetching pass PR diffs', progress: 48 },
  { script: 'sectors', label: 'Assigning sectors', progress: 58 },
  { script: 'intent', label: 'Extracting hierarchy and resources', progress: 74 },
  { script: 'candidates', label: 'Generating candidate pairs', progress: 88 },
  { script: 'review-packets', label: 'Building review packets', progress: 96 },
  { script: 'audit', label: 'Auditing artifacts', progress: 99 },
];

function now(): string { return new Date().toISOString(); }
function pairKey(a: number, b: number): string { return a < b ? `${a}:${b}` : `${b}:${a}`; }
function parseRepo(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const input = value.trim().replace(/^git\s+clone\s+/i, '').trim();
  const ssh = input.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const url = input.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i);
  if (url) return `${url[1]}/${url[2]}`;
  const short = input.match(/^([\w.-]+)\/([\w.-]+)$/);
  return short ? `${short[1]}/${short[2]}` : undefined;
}
function safeRunId(repo: string): string {
  return `${repo.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
}
function publicRun(run: RunState): Omit<RunState, 'child' | 'dataDir'> {
  const { child: _child, dataDir: _dataDir, ...safe } = run;
  return safe;
}
function persist(run: RunState): void {
  fs.mkdirSync(run.dataDir, { recursive: true });
  fs.writeFileSync(path.join(run.dataDir, 'run.json'), JSON.stringify(publicRun(run), null, 2));
}
function appendLog(run: RunState, chunk: Buffer | string): void {
  const lines = String(chunk).split(/\r?\n/).filter(Boolean);
  run.logs.push(...lines.map((line) => line.slice(0, 1_000)));
  if (run.logs.length > LOG_LIMIT) run.logs.splice(0, run.logs.length - LOG_LIMIT);
  run.updatedAt = now();
  persist(run);
}
function loadStoredRuns(): void {
  if (!fs.existsSync(RUNS_DIR)) return;
  for (const name of fs.readdirSync(RUNS_DIR)) {
    const dataDir = path.join(RUNS_DIR, name);
    const metaPath = path.join(dataDir, 'run.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const saved = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Omit<RunState, 'dataDir'>;
      const status = saved.status === 'running' || saved.status === 'queued' ? 'failed' : saved.status;
      jobs.set(saved.id, { ...saved, status, error: status === 'failed' && !saved.error ? 'Server stopped before the run completed.' : saved.error, dataDir });
    } catch { /* Ignore incomplete metadata. */ }
  }
}

async function runScript(run: RunState, script: string, env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['run', script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    run.child = child;
    child.stdout?.on('data', (chunk) => appendLog(run, chunk));
    child.stderr?.on('data', (chunk) => appendLog(run, chunk));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      run.child = undefined;
      if (run.status === 'cancelled') return resolve();
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with ${code ?? signal ?? 'unknown'}`));
    });
  });
}
async function execute(run: RunState, token: string, pairBudget: number, maxPrs?: number): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REPO: run.repo,
    GITHUB_TOKEN: token,
    DATA_DIR: run.dataDir,
    PAIR_BUDGET: String(pairBudget),
    ...(maxPrs ? { MAX_PRS: String(maxPrs) } : {}),
  };
  run.status = 'running';
  run.updatedAt = now();
  persist(run);
  try {
    for (const stage of stages) {
      if ((run.status as RunStatus) === 'cancelled') return;
      run.stage = stage.label;
      run.progress = stage.progress;
      persist(run);
      await runScript(run, stage.script, env);
    }
    run.status = 'complete';
    run.stage = 'Ready for review';
    run.progress = 100;
    run.updatedAt = now();
    persist(run);
  } catch (error) {
    run.status = 'failed';
    run.stage = 'Analysis failed';
    run.error = error instanceof Error ? error.message : String(error);
    run.updatedAt = now();
    appendLog(run, run.error);
    persist(run);
  }
}

function countLines(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  const text = fs.readFileSync(filePath, 'utf8').trim();
  return text ? text.split('\n').length : 0;
}
function buildSummary(dataDir: string, repo: string) {
  const step0 = readJsonl<Step0Result>(path.join(dataDir, 'step0.jsonl'));
  const cards = readJsonl<IntentCard>(path.join(dataDir, 'intent-cards.jsonl'));
  const sectors = readJsonl<SectorCard>(path.join(dataDir, 'sectors.jsonl'));
  const queue = readJsonl<CandidatePair>(path.join(dataDir, 'candidate-pairs.jsonl'));
  const byVerdict = { pass: 0, excluded: 0, deferred: 0 };
  for (const row of step0) byVerdict[row.verdict]++;
  const sectorCounts = new Map<string, number>();
  for (const card of sectors) for (const assignment of card.sectors) sectorCounts.set(assignment.sector, (sectorCounts.get(assignment.sector) ?? 0) + 1);
  const domainCounts = new Map<string, number>();
  for (const card of cards) for (const entry of card.hierarchy) {
    const name = `${entry.sector} / ${entry.domain}${entry.subDomain ? ` / ${entry.subDomain}` : ''}`;
    domainCounts.set(name, (domainCounts.get(name) ?? 0) + 1);
  }
  const theoreticalPairs = cards.length * (cards.length - 1) / 2;
  const retrievalCandidates = countLines(path.join(dataDir, 'candidate-pairs-all.jsonl'));
  return {
    repo,
    openPrs: step0.length || countLines(path.join(dataDir, 'prs.jsonl')),
    ...byVerdict,
    cards: cards.length,
    theoreticalPairs,
    retrievalCandidates,
    queue: queue.length,
    reductionPct: theoreticalPairs ? Number((100 * (1 - retrievalCandidates / theoreticalPairs)).toFixed(3)) : 0,
    sectors: [...sectorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([name, count]) => ({ name, count })),
    domains: [...domainCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, count]) => ({ name, count })),
  };
}
function summarize(dataDir: string, repo: string) {
  const complete = fs.existsSync(path.join(dataDir, 'review-packets.jsonl'));
  if (complete && summaryCache.has(dataDir)) return summaryCache.get(dataDir)!;
  const value = buildSummary(dataDir, repo);
  if (complete) summaryCache.set(dataDir, value);
  return value;
}
function buildQueueResults(dataDir: string) {
  const cards = new Map(readJsonl<IntentCard>(path.join(dataDir, 'intent-cards.jsonl')).map((card) => [card.pr, card]));
  return readJsonl<CandidatePair>(path.join(dataDir, 'candidate-pairs.jsonl')).map((candidate) => ({
    ...candidate,
    titleA: cards.get(candidate.prA)?.title ?? `PR #${candidate.prA}`,
    titleB: cards.get(candidate.prB)?.title ?? `PR #${candidate.prB}`,
    assumptionsA: cards.get(candidate.prA)?.assumptions.slice(0, 3) ?? [],
    assumptionsB: cards.get(candidate.prB)?.assumptions.slice(0, 3) ?? [],
  }));
}
function queueResults(dataDir: string) {
  if (queueCache.has(dataDir)) return queueCache.get(dataDir)!;
  const value = buildQueueResults(dataDir);
  if (fs.existsSync(path.join(dataDir, 'review-packets.jsonl'))) queueCache.set(dataDir, value);
  return value;
}
function buildGraphResults(dataDir: string) {
  const cards = readJsonl<IntentCard>(path.join(dataDir, 'intent-cards.jsonl'));
  const rawPrs = new Map(readJsonl<RawPr>(path.join(dataDir, 'prs.jsonl')).map((pr) => [pr.number, pr]));
  const verdicts = new Map(readJsonl<Step0Result>(path.join(dataDir, 'step0.jsonl')).map((row) => [row.pr, row.verdict]));
  const resourceIndex = new Map<string, { key: string; kind: string; prs: Set<number>; operations: Set<string> }>();
  const dependencies: Array<{ from: number; to: number; relation: string }> = [];
  const dependencyKeys = new Set<string>();
  for (const card of cards) {
    for (const resource of card.touchedResources) {
      const entry = resourceIndex.get(resource.key) ?? { key: resource.key, kind: resource.kind, prs: new Set<number>(), operations: new Set<string>() };
      entry.prs.add(card.pr); entry.operations.add(resource.operation); resourceIndex.set(resource.key, entry);
    }
    for (const dependency of card.dependencies) {
      const key = `${card.pr}:${dependency.pr}:${dependency.relation}`;
      if (!dependencyKeys.has(key)) { dependencyKeys.add(key); dependencies.push({ from: card.pr, to: dependency.pr, relation: dependency.relation }); }
    }
  }
  const resources = [...resourceIndex.values()]
    .sort((a, b) => b.prs.size - a.prs.size || a.key.localeCompare(b.key))
    .slice(0, 250)
    .map((entry) => ({ key: entry.key, kind: entry.kind, count: entry.prs.size, prs: [...entry.prs], operations: [...entry.operations] }));
  const passIds = new Set(cards.map((card) => card.pr));
  const externalIds = [...new Set(dependencies.flatMap((dependency) => [dependency.from, dependency.to]).filter((pr) => !passIds.has(pr)))];
  return {
    prs: cards.map((card) => ({
      pr: card.pr, title: card.title, sectors: card.sectors, hierarchy: card.hierarchy,
      resources: card.touchedResources.map((resource) => resource.key),
      assumptions: card.assumptions.slice(0, 3), evidenceQuality: card.evidenceQuality,
    })),
    dependencies,
    externalPrs: externalIds.map((pr) => ({ pr, title: rawPrs.get(pr)?.title ?? `PR #${pr}`, verdict: verdicts.get(pr) ?? 'external' })),
    resources,
  };
}
function graphResults(dataDir: string) {
  if (graphCache.has(dataDir)) return graphCache.get(dataDir)!;
  const value = buildGraphResults(dataDir);
  if (fs.existsSync(path.join(dataDir, 'review-packets.jsonl'))) graphCache.set(dataDir, value);
  return value;
}
function packetDetail(dataDir: string, a: number, b: number): ReviewPacket | undefined {
  const wanted = pairKey(a, b);
  let packets = packetCache.get(dataDir);
  if (!packets) {
    packets = readJsonl<ReviewPacket>(path.join(dataDir, 'review-packets.jsonl'));
    if (fs.existsSync(path.join(dataDir, 'review-packets.jsonl'))) packetCache.set(dataDir, packets);
  }
  return packets.find((packet) => pairKey(packet.prA.pr, packet.prB.pr) === wanted);
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function staticFile(res: http.ServerResponse, pathname: string): void {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const target = path.resolve(WEB_DIR, relative);
  if (!target.startsWith(`${WEB_DIR}${path.sep}`) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) return json(res, 404, { error: 'Not found' });
  const ext = path.extname(target);
  const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60' });
  fs.createReadStream(target).pipe(res);
}
async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let value = '';
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 65_536) throw new Error('Request too large');
  }
  return value ? JSON.parse(value) as Record<string, unknown> : {};
}
function resolveRun(id: string): { run: RunState | undefined; dataDir: string | undefined; repo: string | undefined } {
  if (id === 'openclaw-current' && fs.existsSync(path.join(CURRENT_DATA_DIR, 'review-packets.jsonl'))) {
    return { run: undefined, dataDir: CURRENT_DATA_DIR, repo: process.env.REPO ?? 'openclaw/openclaw' };
  }
  const run = jobs.get(id);
  return { run, dataDir: run?.dataDir, repo: run?.repo };
}

loadStoredRuns();
fs.mkdirSync(RUNS_DIR, { recursive: true });
if (fs.existsSync(path.join(CURRENT_DATA_DIR, 'review-packets.jsonl'))) {
  const currentRepo = process.env.REPO ?? 'openclaw/openclaw';
  summarize(CURRENT_DATA_DIR, currentRepo);
  queueResults(CURRENT_DATA_DIR);
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
    const pathname = requestUrl.pathname;
    if (pathname === '/api/health') return json(res, 200, { ok: true, localOnly: HOST === '127.0.0.1' });
    if (pathname === '/api/runs' && req.method === 'GET') {
      const current = fs.existsSync(path.join(CURRENT_DATA_DIR, 'review-packets.jsonl')) ? [{
        id: 'openclaw-current', repo: process.env.REPO ?? 'openclaw/openclaw', status: 'complete', stage: 'Ready for review', progress: 100,
        createdAt: fs.statSync(path.join(CURRENT_DATA_DIR, 'review-packets.jsonl')).mtime.toISOString(), updatedAt: fs.statSync(path.join(CURRENT_DATA_DIR, 'review-packets.jsonl')).mtime.toISOString(), logs: [],
      }] : [];
      return json(res, 200, [...current, ...[...jobs.values()].map(publicRun).sort((a, b) => b.createdAt.localeCompare(a.createdAt))]);
    }
    if (pathname === '/api/runs' && req.method === 'POST') {
      const input = await body(req);
      const repo = parseRepo(input.repo);
      if (!repo) return json(res, 400, { error: 'Use owner/repo or a GitHub clone URL.' });
      const token = typeof input.token === 'string' && input.token.trim() ? input.token.trim() : process.env.GITHUB_TOKEN;
      if (!token) return json(res, 400, { error: 'A GitHub token is required for a full repository scan.' });
      const pairBudget = Math.min(1_000, Math.max(10, Number(input.pairBudget ?? 100) || 100));
      const maxPrsRaw = Number(input.maxPrs ?? 0);
      const maxPrs = Number.isFinite(maxPrsRaw) && maxPrsRaw > 0 ? Math.floor(maxPrsRaw) : undefined;
      const id = safeRunId(repo);
      const run: RunState = { id, repo, dataDir: path.join(RUNS_DIR, id), status: 'queued', stage: 'Queued', progress: 0, createdAt: now(), updatedAt: now(), logs: [] };
      jobs.set(id, run);
      persist(run);
      void execute(run, token, pairBudget, maxPrs);
      return json(res, 202, publicRun(run));
    }
    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && req.method === 'GET') {
      const resolved = resolveRun(runMatch[1]);
      if (!resolved.dataDir || !resolved.repo) return json(res, 404, { error: 'Run not found' });
      const run = resolved.run ? publicRun(resolved.run) : { id: runMatch[1], repo: resolved.repo, status: 'complete', stage: 'Ready for review', progress: 100, logs: [] };
      return json(res, 200, { ...run, summary: summarize(resolved.dataDir, resolved.repo) });
    }
    const resultMatch = pathname.match(/^\/api\/runs\/([^/]+)\/results$/);
    if (resultMatch && req.method === 'GET') {
      const resolved = resolveRun(resultMatch[1]);
      if (!resolved.dataDir || !resolved.repo) return json(res, 404, { error: 'Run not found' });
      return json(res, 200, { summary: summarize(resolved.dataDir, resolved.repo), pairs: queueResults(resolved.dataDir), graph: graphResults(resolved.dataDir) });
    }
    const pairMatch = pathname.match(/^\/api\/runs\/([^/]+)\/pairs\/(\d+)\/(\d+)$/);
    if (pairMatch && req.method === 'GET') {
      const resolved = resolveRun(pairMatch[1]);
      if (!resolved.dataDir) return json(res, 404, { error: 'Run not found' });
      const packet = packetDetail(resolved.dataDir, Number(pairMatch[2]), Number(pairMatch[3]));
      return packet ? json(res, 200, packet) : json(res, 404, { error: 'Review packet not found' });
    }
    const cancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      const run = jobs.get(cancelMatch[1]);
      if (!run) return json(res, 404, { error: 'Run not found' });
      run.status = 'cancelled'; run.stage = 'Cancelled'; run.updatedAt = now(); run.child?.kill('SIGTERM'); persist(run);
      return json(res, 200, publicRun(run));
    }
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    return staticFile(res, pathname);
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PR Conflict Radar running at http://${HOST}:${PORT}`);
  console.log('OpenClaw results are available as the preloaded current run.');
});
