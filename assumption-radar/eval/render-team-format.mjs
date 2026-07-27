#!/usr/bin/env node
// 기존 raw-*.json 에서 팀원 리포트와 동일한 형식의 md 를 생성한다. (재스캔 불필요)
// 사용: node eval/render-team-format.mjs reports/raw-deterministic-main-6e3548e-2026-07-20.json
import { readFile, writeFile } from "node:fs/promises";

const src = process.argv[2];
if (!src) { console.error("사용: node eval/render-team-format.mjs <raw-*.json>"); process.exit(1); }
const j = JSON.parse(await readFile(src, "utf8"));
const ok = j.results.filter((r) => r.ok);

const kst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 16);
const prNum = (r, id) => { const p = (r.data.prs || []).find((x) => String(x.id) === String(id)); return p ? p.number : id; };
const link = (slug, n) => `[#${n}](https://github.com/${slug}/pull/${n})`;
const sum = (f) => ok.reduce((a, r) => a + (f(r.data.summary) || 0), 0);
const psum = (f) => ok.reduce((a, r) => a + (f(r.data.preflight || {}) || 0), 0);
const sem = (r) => (r.data.findings || []).filter((x) => x.verdict === "conflict");
const rev = (r) => (r.data.findings || []).filter((x) => x.verdict === "review");
const coord = (r) => (r.data.findings || []).filter((x) => x.verdict === "coordination");

const aiLabel = j.useAi ? `${j.provider} (bounded second-look)` : "**사용 안 함 (결정적 분석만)**";
let md = `# Assumption Radar ${ok.length}개 Java OSS 전체 open PR live scan${j.useAi ? ` — ${j.provider}` : " — deterministic only"}\n\n`;

// ── 결론 ──
const totSem = sum((s) => s.conflictCount), totRev = sum((s) => s.reviewCount), totCoord = sum((s) => s.coordinationCount);
md += `## 결론\n\n`;
md += `${ok.length}개 저장소의 **전체 open PR ${sum((s) => s.prCount)}개, ${sum((s) => s.pairCount).toLocaleString()}쌍**을 분석했다. `;
md += `결정적(deterministic) semantic conflict **${totSem}건**, review **${totRev}건**, **Git text coordination ${totCoord}건**이 확인됐다.\n\n`;
if (!j.useAi) md += `> **AI second-look 을 실행하지 않았다.** 이 수치는 순수 결정적 분석 결과이며, 모델 선택과 무관하므로 다른 팀원 결과와 직접 비교 가능하다.\n\n`;
md += `Docker Base/A/B/A+B 결합 실행은 하지 않았다. 따라서 아래 판정은 실행으로 재현된 충돌이 아니다.\n\n`;

// ── 실행 조건 ──
md += `## 실행 조건\n\n| 항목 | 값 |\n|---|---|\n`;
md += `| 실행 시각 | ${kst(j.startedAt)}–${kst(j.finishedAt)} KST |\n`;
md += `| 애플리케이션 | Assumption Radar 1.0.0 |\n`;
md += `| Git commit | \`${(j.tag || "").replace(/^(main|pre)-/, "") || "(기록 없음)"}\` |\n`;
md += `| 입력 범위 | 실행 시점의 전체 open PR |\n`;
md += `| 분석 범위 | ${sum((s) => s.prCount)} PR, ${sum((s) => s.pairCount).toLocaleString()} pair |\n`;
md += `| Git 검사 | 관련성이 있는 ${psum((p) => p.inspectedPairs).toLocaleString()} pair 를 current base 기준 \`git merge-tree\` 로 검사 |\n`;
md += `| AI | ${aiLabel} |\n`;
md += `| 실행 검증 | Docker Base/A/B/A+B 미실행 |\n\n`;

// ── 저장소별 결과 ──
md += `## 저장소별 결과\n\n`;
md += `| Repository | 전체 open PR | Pair | Semantic conflict | Review | Git coordination | Insufficient | Independent |\n`;
md += `|---|---:|---:|---:|---:|---:|---:|---:|\n`;
for (const r of ok) {
  const s = r.data.summary;
  md += `| [${r.slug}](https://github.com/${r.slug}/pulls) | ${s.prCount} | ${s.pairCount.toLocaleString()} | ${s.conflictCount} | ${s.reviewCount} | ${s.coordinationCount} | ${s.insufficientCount} | ${s.independentCount.toLocaleString()} |\n`;
}
md += `| **합계** | **${sum((s) => s.prCount)}** | **${sum((s) => s.pairCount).toLocaleString()}** | **${totSem}** | **${totRev}** | **${totCoord}** | **${sum((s) => s.insufficientCount)}** | **${sum((s) => s.independentCount).toLocaleString()}** |\n\n`;
const noAlert = sum((s) => s.noAlertUnreviewedCount);
md += `\`Independent\` ${sum((s) => s.independentCount).toLocaleString()}건 중 ${noAlert.toLocaleString()}건은 deterministic 무경고 후 미검토인 \`no-alert-unreviewed\` 다. 따라서 전체 호환성 증명으로 해석하면 안 된다.\n\n`;

// ── semantic / review 상세 ──
const anySem = ok.some((r) => sem(r).length), anyRev = ok.some((r) => rev(r).length);
if (anySem || anyRev) {
  md += `## Semantic 판정 상세\n\n`;
  for (const r of ok) {
    for (const c of [...sem(r), ...rev(r)]) {
      const ns = (c.prIds || []).map((id) => prNum(r, id));
      md += `### ${r.slug.split("/")[1]} \`${ns.map((n) => "#" + n).join(" × ")}\` — ${c.verdict}\n\n`;
      md += `- 대상: ${ns.map((n) => link(r.slug, n)).join(" × ")}\n`;
      md += `- 제목: ${c.title}\n`;
      md += `- 요약: ${c.summary}\n`;
      if (c.category) md += `- 카테고리: \`${c.category}\`\n`;
      const ev = (c.evidence || []).filter((e) => typeof e === "string").slice(0, 3);
      if (ev.length) md += `- 근거: ${ev.map((e) => "`" + String(e).slice(0, 90) + "`").join(", ")}\n`;
      if (c.recommendation) md += `- 권장 조치: ${c.recommendation}\n`;
      md += `\n`;
    }
  }
}

// ── Git coordination 상세 ──
md += `## Git text coordination ${totCoord}건\n\n`;
if (!totCoord) md += `없음.\n\n`;
else {
  md += `| Repository | PR pair | 충돌 파일 |\n|---|---|---|\n`;
  for (const r of ok) {
    for (const c of coord(r)) {
      const ns = (c.prIds || []).map((id) => prNum(r, id));
      const file = (c.evidence || []).find((e) => typeof e === "string" && e.includes("/")) || (c.title.split(": ")[1] || "");
      md += `| ${r.slug.split("/")[1]} | ${ns.map((n) => link(r.slug, n)).join(" × ")} | \`${file}\` |\n`;
    }
  }
  md += `\n이 ${totCoord}건은 Git 이 먼저 막는 기계적 conflict 이며 silent semantic conflict 수에는 포함하지 않는다.\n\n`;
}

// ── preflight ──
md += `## Git preflight 상태\n\n`;
md += `| Repository | 검사 pair | Clean | Text conflict | Base-conflict pair | 비교 불가 pair | Base-conflict PR 수 | Base 준비 불가 PR 수 |\n`;
md += `|---|---:|---:|---:|---:|---:|---:|---:|\n`;
for (const r of ok) {
  const p = r.data.preflight || {};
  md += `| ${r.slug.split("/")[1]} | ${(p.inspectedPairs || 0).toLocaleString()} | ${p.cleanPairs || 0} | ${p.textualConflictPairs || 0} | ${p.baseConflictPairs || 0} | ${p.unavailablePairs || 0} | ${(p.baseConflictPrNumbers || []).length} | ${(p.baseUnavailablePrNumbers || []).length} |\n`;
}
md += `| **합계** | **${psum((p) => p.inspectedPairs).toLocaleString()}** | **${psum((p) => p.cleanPairs)}** | **${psum((p) => p.textualConflictPairs)}** | **${psum((p) => p.baseConflictPairs)}** | **${psum((p) => p.unavailablePairs)}** | **${ok.reduce((a, r) => a + (r.data.preflight.baseConflictPrNumbers || []).length, 0)}** | **${ok.reduce((a, r) => a + (r.data.preflight.baseUnavailablePrNumbers || []).length, 0)}** |\n\n`;
md += `\`Insufficient\` 는 semantic conflict 가 아니라, 관련 pair 중 한쪽 PR 이 current base 와 먼저 충돌해 판정을 보류한 수다.\n\n`;
// stack collapse
const stacked = ok.filter((r) => (r.data.preflight.suppressedPrNumbers || []).length);
if (stacked.length) {
  md += `### Stack collapse\n\n`;
  for (const r of stacked) md += `- ${r.slug}: ${(r.data.preflight.suppressedPrNumbers || []).map((n) => "#" + n).join(", ")} 접힘\n`;
  md += `\n`;
}

md += `## 해석 경계\n\n`;
md += `- ${kst(j.finishedAt).slice(0, 10)} 실행 시점의 전체 open PR snapshot 이다. 이후 PR 상태나 head SHA 가 바뀌면 결과도 바뀐다.\n`;
md += `- deterministic 분석은 ${sum((s) => s.pairCount).toLocaleString()} pair 전체에 수행했지만, Git preflight 는 상호작용 신호가 있는 ${psum((p) => p.inspectedPairs).toLocaleString()} pair 에만 수행됐다.\n`;
md += `- semantic conflict, Git text coordination, current-base conflict 는 서로 다른 gate 다.\n`;
md += `- Docker 결합 실행을 하지 않았으므로 confirmed pair regression 은 0건이다.\n`;
if (!j.useAi) md += `- **AI second-look 미실행.** AI 판정 항목은 정의상 0이며, 다른 팀원 리포트의 AI 산출물과 직접 비교 대상이 아니다.\n`;

const out = src.replace(/raw-/, "report-team-format-").replace(/\.json$/, ".md");
await writeFile(out, md);
console.log("생성:", out);