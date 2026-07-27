#!/usr/bin/env node
// 3개 레포 live 스캔 + 팀원 리포트 형식의 md 리포트 자동 생성
//
// 사용:
//   GITHUB_TOKEN=... node eval/run-three-repo-report.mjs
//   GITHUB_TOKEN=... ANTHROPIC_API_KEY=... node eval/run-three-repo-report.mjs --ai
//
// --ai 없이 돌리면 결정적 분석만 수행한다. 결정적 층은 모델과 무관하므로
// 다른 팀원(Codex/gpt-5.6-sol) 결과와 직접 비교 가능한 부분이다.
import { spawn } from "node:child_process";
import { writeFile, mkdir, readFile } from "node:fs/promises";

// assumption-radar/.env 를 읽어 환경변수로 주입한다.
// (앱 본체는 .env 를 읽지 않는 설계라, 이 러너에서만 로드해 자식 프로세스에 물려준다.)
// .env 는 .gitignore 에 등록돼 있어 커밋되지 않는다.
async function loadDotEnv(path = ".env") {
  let text;
  try { text = await readFile(path, "utf8"); } catch { return 0; }
  let n = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!val || val.includes("...")) continue;   // .env.example 자리표시자 무시
    if (process.env[key]) continue;              // 실제 환경변수가 우선
    process.env[key] = val;
    n++;
  }
  return n;
}
const loaded = await loadDotEnv();
if (loaded) console.log(`.env 에서 ${loaded}개 변수 로드`);

const DEFAULT_REPOS = [
  { slug: "spring-projects/spring-boot", limit: 27 },
  { slug: "apache/zeppelin", limit: 62 },
  { slug: "opensearch-project/opensearch-java", limit: 22 },
];
// 위치 인자로 레포를 주면 그걸 쓴다: owner/repo 또는 owner/repo:limit
// limit 을 생략하면 --limit 없이(=수집 가능한 전체 open PR) 실행한다.
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--") && a.includes("/"));
const REPOS = positional.length
  ? positional.map((a) => {
      const [slug, lim] = a.split(":");
      return { slug, limit: lim ? Number(lim) : null };
    })
  : DEFAULT_REPOS;
// 리포트 파일 이름에 붙일 태그 (--tag main / --tag 9cf9abe 등)
const tagIdx = process.argv.indexOf("--tag");
const TAG = tagIdx >= 0 ? process.argv[tagIdx + 1] : null;

const useAi = process.argv.includes("--ai");
const provider = (() => {
  const i = process.argv.indexOf("--ai-provider");
  return i >= 0 ? process.argv[i + 1] : "anthropic";
})();

if (!process.env.GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN 이 필요합니다. PR 수집이 rate limit 에 막힙니다.");
  process.exit(1);
}
if (useAi && provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
  console.error("--ai --ai-provider anthropic 에는 ANTHROPIC_API_KEY 가 필요합니다.");
  console.error("(Claude Code 구독은 이 코드가 쓰지 못합니다 — console.anthropic.com API 키 필요)");
  process.exit(1);
}

function runScan({ slug, limit }) {
  const args = ["src/cli.mjs", slug, "--preflight", "--json"];
  if (limit) args.splice(2, 0, "--limit", String(limit));   // limit 없으면 수집 가능한 전체 open PR
  if (useAi) args.push("--ai", "--ai-provider", provider);
  return new Promise((resolve) => {
    const started = Date.now();
    // 일부 실행 환경은 GIT_CONFIG_COUNT/KEY/VALUE 로 safe.bareRepository=explicit 를 주입한다.
    // 그러면 preflight 가 bare 캐시 repo 를 다루지 못해 git merge-tree 검사가 통째로 스킵되고
    // coordination/insufficient 가 0 으로 보인다(조용한 실패). 자식 프로세스에서 걷어낸다.
    const env = { ...process.env };
    const n = Number(env.GIT_CONFIG_COUNT || 0);
    for (let i = 0; i < n; i++) { delete env[`GIT_CONFIG_KEY_${i}`]; delete env[`GIT_CONFIG_VALUE_${i}`]; }
    delete env.GIT_CONFIG_COUNT;
    delete env.GIT_CONFIG_PARAMETERS;
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      const elapsedMs = Date.now() - started;
      // --fail-on 을 쓰지 않으므로 conflict 가 있어도 exit 0. 비정상 종료만 실패 처리.
      try {
        resolve({ slug, limit, ok: true, elapsedMs, data: JSON.parse(out), exitCode: code });
      } catch (e) {
        resolve({ slug, limit, ok: false, elapsedMs, exitCode: code, error: (err || String(e)).slice(0, 800) });
      }
    });
  });
}

const startedAt = new Date();
console.log(`시작 ${startedAt.toISOString()} | AI: ${useAi ? provider : "off (deterministic only)"}`);
const results = [];
for (const repo of REPOS) {
  process.stdout.write(`스캔 ${repo.slug} (limit ${repo.limit}) ... `);
  const r = await runScan(repo);
  results.push(r);
  if (r.ok) {
    const s = r.data.summary;
    console.log(`OK ${Math.round(r.elapsedMs / 1000)}s | PR ${s.prCount} pair ${s.pairCount} conflict ${s.conflictCount} coord ${s.coordinationCount} insuf ${s.insufficientCount}`);
  } else {
    console.log(`FAILED (exit ${r.exitCode}) — ${r.error?.split("\n")[0]}`);
  }
}
const finishedAt = new Date();

// ── 리포트 생성 ──────────────────────────────────────────────
const kst = (d) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16) + " KST";
const ok = results.filter((r) => r.ok);
const sum = (f) => ok.reduce((a, r) => a + (f(r.data.summary) || 0), 0);

let md = `# Assumption Radar live three-repository run — ${useAi ? provider : "deterministic only"}\n\n`;
md += `## 실행 조건\n\n| 항목 | 값 |\n|---|---|\n`;
md += `| 실행 완료 | ${kst(finishedAt)} (${finishedAt.toISOString()}) |\n`;
md += `| 애플리케이션 | Assumption Radar 1.0.0 |\n`;
md += `| AI provider / model | ${useAi ? `${provider} / ${provider === "anthropic" ? (process.env.ANTHROPIC_MODEL || "claude-opus-4-8") : "(provider default)"}` : "사용 안 함 (결정적 분석만)"} |\n`;
md += `| 분석 명령 | \`npm run scan -- <owner/repo> --limit <N> --preflight${useAi ? ` --ai --ai-provider ${provider}` : ""}\` |\n`;
md += `| Pair 범위 | 수집 후 stack collapse 를 적용한 모든 open PR 조합 |\n`;
md += `| Git 검사 | current base 로 정규화한 git merge-tree preflight |\n`;
md += `| Docker Base/A/B/A+B | 실행하지 않음 |\n\n`;

md += `## 전체 요약\n\n`;
md += `| Repository | 요청 PR | 수집 PR | 전체 pair | Semantic conflict | Review | Git coordination | Insufficient | Independent | 소요 |\n`;
md += `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
for (const r of results) {
  if (!r.ok) { md += `| ${r.slug} | ${r.limit} | — | — | — | — | — | — | — | 실패 |\n`; continue; }
  const s = r.data.summary;
  md += `| ${r.slug} | ${r.limit} | ${s.prCount} | ${s.pairCount} | ${s.conflictCount} | ${s.reviewCount} | ${s.coordinationCount} | ${s.insufficientCount} | ${s.independentCount} | ${Math.round(r.elapsedMs / 1000)}s |\n`;
}
md += `| **Total** | ${REPOS.reduce((a, r) => a + r.limit, 0)} | ${sum((s) => s.prCount)} | ${sum((s) => s.pairCount)} | ${sum((s) => s.conflictCount)} | ${sum((s) => s.reviewCount)} | ${sum((s) => s.coordinationCount)} | ${sum((s) => s.insufficientCount)} | ${sum((s) => s.independentCount)} | |\n\n`;

// 수량 차이 (요청 vs 실제)
const drift = results.filter((r) => r.ok && r.data.summary.prCount !== r.limit);
if (drift.length) {
  md += `### 수량 차이 (open PR 실시간 변동)\n\n`;
  for (const r of drift) md += `- **${r.slug}**: 요청 ${r.limit}개 → 실행 시점 수집 ${r.data.summary.prCount}개\n`;
  md += `\n`;
}

// Semantic conflict 상세
md += `## Semantic conflict 상세\n\n`;
const anyConflict = ok.some((r) => (r.data.conflicts || []).length);
if (!anyConflict) md += `이번 스냅샷에서 semantic conflict 판정은 없었다.\n\n`;
else {
  md += `| Repository | PR pair | 판정 source | 근거 | 권장 조치 |\n|---|---|---|---|---|\n`;
  for (const r of ok) {
    for (const c of r.data.conflicts || []) {
      const prs = (c.prIds || []).map((p) => `#${p}`).join(" × ");
      const src = c.aiVerdict || c.source || (c.witnesses?.length ? "deterministic" : "—");
      md += `| ${r.slug.split("/")[1]} | ${prs} | ${src} | ${(c.summary || c.title || "").replace(/\|/g, "\\|")} | ${(c.recommendation || "").replace(/\|/g, "\\|")} |\n`;
    }
  }
  md += `\n`;
}

// Preflight
md += `## Preflight 보류 현황\n\n| Repository | Base-conflict PR | Base-unavailable PR | Textual conflict pair |\n|---|---|---|---:|\n`;
for (const r of ok) {
  const p = r.data.preflight || {};
  const f = (a) => (a && a.length ? a.map((n) => `#${n}`).join(", ") : "없음");
  md += `| ${r.slug} | ${f(p.baseConflictPrNumbers)} | ${f(p.baseUnavailablePrNumbers)} | ${p.textualConflictPairs ?? 0} |\n`;
}
md += `\n`;

md += `## 비교 시 해석 경계\n\n`;
md += `- 이 결과는 ${kst(finishedAt).slice(0, 10)} live open-PR snapshot 이다. repository / 실행 시각 / PR 목록 / base SHA 가 다르면 raw count 를 정확도 차이로 해석하면 안 된다.\n`;
md += `- semantic conflict, Git coordination, insufficient 는 서로 다른 gate 다. 세 수치를 합쳐 하나의 conflict 수로 비교하지 않는다.\n`;
md += `- **결정적 분석은 모델과 무관**하므로 다른 팀원 결과와 직접 비교 가능하다. ${useAi ? `AI second-look(${provider}) 판정만 모델별로 달라진다.` : `이번 실행은 AI second-look 을 사용하지 않았다.`}\n`;
md += `- Docker Base/A/B/A+B 검증을 실행하지 않았으므로 confirmed-conflict 는 0 이며, semantic conflict 는 실행 재현 결과가 아니다.\n`;

await mkdir("reports", { recursive: true });
const stamp = finishedAt.toISOString().slice(0, 10);
const suffix = TAG ? `-${TAG}` : "";
const base = `${useAi ? provider : "deterministic"}${suffix}-${stamp}`;
const name = `reports/pr-conflict-live-${base}.md`;
await writeFile(name, md);
await writeFile(`reports/raw-${base}.json`,
  JSON.stringify({ startedAt, finishedAt, useAi, provider, tag: TAG, results }, null, 2));

console.log(`\n리포트: ${name}`);
console.log(`원본 JSON: reports/raw-${base}.json`);
if (results.some((r) => !r.ok)) process.exitCode = 1;