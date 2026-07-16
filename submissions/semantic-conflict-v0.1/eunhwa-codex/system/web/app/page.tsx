"use client";

import { useState } from "react";
import { analyze, type AnalysisResult } from "./lib/analyzer";
import { demoPullRequests } from "./lib/demo";
import { ConflictGraph } from "./components/ConflictGraph";
import { ConflictComparisonGraph } from "./components/ConflictComparisonGraph";

const empty: AnalysisResult = { eligiblePrs: 0, cards: [], candidates: [], conflicts: [], needsVerification: [], pairTextConflicts: [], excluded: [] };

export default function Home() {
  const [repository, setRepository] = useState("");
  const [token, setToken] = useState("");
  const [result, setResult] = useState<AnalysisResult>(empty);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [activeLabel, setActiveLabel] = useState("Acceptance scenario");
  const [visibleTextCount, setVisibleTextCount] = useState(40);
  const [visibleLlmCount, setVisibleLlmCount] = useState(40);

  function runDemo() {
    setStatus("running");
    setError("");
    window.setTimeout(() => {
      setResult(analyze(demoPullRequests));
      setVisibleTextCount(40);
      setVisibleLlmCount(40);
      setActiveLabel("Acceptance scenario");
      setStatus("done");
    }, 350);
  }

  async function runRepository(event: React.FormEvent) {
    event.preventDefault();
    setStatus("running");
    setError("");
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository, token: token || undefined }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Analysis failed");
      setResult(payload);
      setVisibleTextCount(40);
      setVisibleLlmCount(40);
      setActiveLabel(`${repository} · contract-only live scan`);
      setStatus("done");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "분석에 실패했습니다.");
      setStatus("error");
    }
  }

  const hasResult = status === "done";
  const verificationFindings = result.needsVerification ?? [];
  const pairTextConflicts = result.pairTextConflicts ?? [];
  const llmFindings = result.llmFindings ?? [];
  const combinedVerifications = result.combinedVerifications ?? [];
  const pairKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
  const textConflictKeys = new Set(pairTextConflicts.map((finding) => pairKey(finding.a, finding.b)));
  const combinedByPair = new Map(combinedVerifications.map((finding) => [pairKey(finding.a, finding.b), finding]));
  const activeLlmFindings = llmFindings.filter((finding) => {
    const key = pairKey(finding.a, finding.b);
    return !textConflictKeys.has(key) && combinedByPair.get(key)?.verdict !== "combined_clean";
  });
  const llmConflicts = activeLlmFindings.filter((finding) => finding.verdict === "llm_conflict");
  const runtimeCombined = combinedVerifications.filter((finding) => !textConflictKeys.has(pairKey(finding.a, finding.b)));
  const combinedConflicts = runtimeCombined.filter((finding) => finding.verdict === "combined_conflict");
  const totalTextConflicts = result.findingSummary?.pairTextConflicts ?? pairTextConflicts.length;
  const totalStaticConflicts = result.findingSummary?.conflicts ?? result.conflicts.length;
  const totalNeedsVerification = result.findingSummary?.needsVerification ?? verificationFindings.length;
  const totalLlmFindings = result.findingSummary?.llmFindings ?? activeLlmFindings.length;
  const hasBinaryConflict = totalTextConflicts > 0
    || totalStaticConflicts > 0
    || totalNeedsVerification > 0
    || totalLlmFindings > 0
    || runtimeCombined.some((finding) => finding.verdict !== "combined_clean");
  const displayCards = result.pairMergeCards ?? result.cards;
  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Contract Radar home">
          <span className="brandMark">CR</span>
          <span>Contract Radar</span>
        </a>
        <span className="scope">OPEN PR · INDIVIDUALLY MERGEABLE · CI ANY</span>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow"><span /> Pair merge + semantic conflict detection</div>
        <h1>혼자 병합되는 PR이<br /><em>함께 충돌하기 전에.</em></h1>
        <p className="lede">CI 성공·실패와 무관하게 동일 base에서 Git 충돌을 재현합니다. text-clean 후보는 각 PR 단독 실행과 combined tree 실행을 비교하고, 실행으로 남는 intent·ordering·ownership·lifecycle만 LLM이 근거 기반으로 판정합니다.</p>
        <div className="pipeline" aria-label="Analysis pipeline">
          <div><b>01</b><span>Dual candidate indexes</span><small>Git path + semantic contract</small></div>
          <i>→</i>
          <div><b>02</b><span>Pair merge</span><small>두 PR head 실제 병합</small></div>
          <i>→</i>
          <div><b>03</b><span>Combined run</span><small>A · B · A+B 차분 실행</small></div>
          <i>→</i>
          <div><b>04</b><span>Semantic judge</span><small>정적 증거 + 2-pass LLM</small></div>
        </div>
      </section>

      <section className="controlPanel">
        <form onSubmit={runRepository}>
          <div className="field repoField">
            <label htmlFor="repository">GitHub repository</label>
            <input id="repository" value={repository} onChange={(event) => setRepository(event.target.value)} placeholder="owner/repository" required />
          </div>
          <div className="field tokenField">
            <label htmlFor="token">Token <span>required for large full-repo scans</span></label>
            <input id="token" value={token} onChange={(event) => setToken(event.target.value)} type="password" placeholder="github_pat_••••" autoComplete="off" />
          </div>
          <button className="primary" type="submit" disabled={status === "running"}>Analyze contracts <span>↗</span></button>
        </form>
        <div className="workerNote"><b>LIVE FORM</b><span>계약 후보까지만 분석합니다. 실제 Git pair merge 결과는 아래 VERIFIED OSS SCANS에서 제공합니다.</span></div>
        <div className="divider"><span>or verify the acceptance case</span></div>
        <button className="demoButton" onClick={runDemo} disabled={status === "running"}>
          <span className="play">▶</span><span><b>Run built-in E2E scenario</b><small>1 positive + 1 negative pair</small></span>
        </button>
        {status === "running" && <div className="notice running"><span /> Reading PR contracts and joining shared resources…</div>}
        {status === "error" && <div className="notice error">{error}</div>}
      </section>

      <section className={`results ${hasResult ? "visible" : ""}`} aria-live="polite">
        <div className="resultsHead">
          <div><span className="sectionNo">ANALYSIS / 03 · {activeLabel}</span><h2>Conflict report</h2></div>
          {hasResult && <span className={`verdict ${hasBinaryConflict ? "danger" : "clear"}`}>{hasBinaryConflict ? "충돌" : "안 충돌"}</span>}
        </div>

        {!hasResult ? (
          <div className="emptyState"><span>⌁</span><p>저장소를 분석하거나 내장 시나리오를 실행하면<br />PR 쌍과 판정 근거가 여기에 표시됩니다.</p></div>
        ) : (
          <>
            <div className="metrics">
              <div><small>Pair-merge PRs</small><strong>{result.pairMergePrs ?? result.eligiblePrs}</strong><span>{result.eligiblePrs} CI passed{result.pairMergeUnavailablePrs ? ` · ${result.pairMergeUnavailablePrs} unavailable` : ""}</span></div>
              <div className={llmConflicts.length ? "warm" : ""}><small>Semantic candidates</small><strong>{result.candidateSummary?.broadSemanticPairs ?? result.semanticCandidates?.length ?? result.candidates.length}</strong><span>{result.llmJudgeSummary ? `${result.llmJudgeSummary.judgedPairs} judged · ${result.llmJudgeSummary.uncertain} uncertain` : `${result.candidateSummary?.contractPairs ?? result.candidates.length} exact contract · ${result.candidateSummary?.mediumSemanticPairs ?? 0} medium`}</span></div>
              <div className={combinedConflicts.length ? "hot" : ""}><small>Combined verified</small><strong>{result.combinedVerificationSummary?.verifiedPairs ?? 0}</strong><span>{result.combinedVerificationSummary ? `${result.combinedVerificationSummary.conflicts} conflict · ${result.combinedVerificationSummary.clean} clean · ${result.combinedVerificationSummary.inconclusive} inconclusive` : "sandboxed A/B/A+B"}</span></div>
              <div className={totalTextConflicts ? "hot" : ""}><small>Git path candidates</small><strong>{result.candidateSummary?.gitPairs ?? result.gitCandidates?.length ?? totalTextConflicts}</strong><span>{totalTextConflicts} merge-tree conflicts</span></div>
              <div className={totalStaticConflicts ? "hot" : ""}><small>Semantic conflicts</small><strong>{totalStaticConflicts}</strong><span>text-clean but incompatible</span></div>
            </div>
            {result.totalOpenPrs !== undefined && <div className="coverage"><b>FULL REPOSITORY COVERAGE</b><span>{result.scannedPrs?.toLocaleString()} scanned / {result.totalOpenPrs.toLocaleString()} open · {(result.pairMergeGatePrs ?? result.eligibleGatePrs)?.toLocaleString()} pair-merge eligible · {result.eligibleGatePrs?.toLocaleString()} CI passed</span></div>}
            {!!(result.findingSummary?.pairMergeErrors ?? result.pairMergeErrors?.length) && <div className="notice error">{result.findingSummary?.pairMergeErrors ?? result.pairMergeErrors?.length} pair merges could not be classified. See the scan artifact for evidence.</div>}

            <ConflictComparisonGraph result={result} />
            <ConflictGraph result={result} />

            {pairTextConflicts.slice(0, visibleTextCount).map((conflict) => {
              const a = displayCards.find((card) => card.pr === conflict.a);
              const b = displayCards.find((card) => card.pr === conflict.b);
              if (!a || !b) return null;
              return (
                <article className="conflictCard textConflictCard" key={`text:${conflict.a}:${conflict.b}`}>
                  <div className="conflictStripe" />
                  <div className="cardTop"><span>충돌</span><b>GIT TEXT · PAIR MERGE PROOF</b></div>
                  <div className="prPair">
                    <div><small>PR #{a.pr} · CI {a.ciStatus?.toUpperCase() ?? "UNKNOWN"}</small><h3>{a.title}</h3></div><span className="collision">×</span><div><small>PR #{b.pr} · CI {b.ciStatus?.toUpperCase() ?? "UNKNOWN"}</small><h3>{b.title}</h3></div>
                  </div>
                  <div className="resourceRow"><span>OVERLAPPING FILE</span>{conflict.sharedResources.map((resource) => <code key={resource}>{resource}</code>)}</div>
                  <p className="rationale">{conflict.rationale}</p>
                  <div className="evidence"><b>Git merge-tree evidence</b>{conflict.evidence.map((line) => <code key={line}>{line}</code>)}</div>
                </article>
              );
            })}
            {pairTextConflicts.length > visibleTextCount && <button className="loadMore" type="button" onClick={() => setVisibleTextCount((count) => count + 40)}>Show 40 more · {pairTextConflicts.length - visibleTextCount} remaining</button>}

            {activeLlmFindings.slice(0, visibleLlmCount).map((finding) => {
              const a = displayCards.find((card) => card.pr === finding.a);
              const b = displayCards.find((card) => card.pr === finding.b);
              if (!a || !b) return null;
              return (
                <article className={`conflictCard llmRiskCard ${finding.verdict === "llm_uncertain" ? "reviewCard" : ""}`} key={`llm:${finding.a}:${finding.b}`}>
                  <div className="conflictStripe" />
                  <div className="cardTop"><span>충돌</span><b>SEMANTIC · {finding.confirmationCount}/2 PASS · {finding.family.toUpperCase()}</b></div>
                  <div className="prPair">
                    <div><small>PR #{a.pr}</small><h3>{a.title}</h3></div><span className="collision">?</span><div><small>PR #{b.pr}</small><h3>{b.title}</h3></div>
                  </div>
                  <div className="resourceRow"><span>SHARED SURFACE</span>{finding.sharedResources.map((resource) => <code key={resource}>{resource}</code>)}</div>
                  <p className="rationale">{finding.claim}</p>
                  <div className="evidence"><b>Supported evidence</b>{finding.evidence.map((item, index) => <code key={`${item.pr}:${item.file}:${index}`}>PR #{item.pr} · {item.file}: {item.quote}</code>)}</div>
                  {!!finding.counterevidence.length && <div className="evidence"><b>Counterevidence / validation</b>{finding.counterevidence.map((line) => <code key={line}>{line}</code>)}</div>}
                  <div className="evidence"><b>Required verification</b>{finding.verification.map((line) => <code key={line}>{line}</code>)}</div>
                </article>
              );
            })}
            {activeLlmFindings.length > visibleLlmCount && <button className="loadMore" type="button" onClick={() => setVisibleLlmCount((count) => count + 40)}>Show 40 more LLM findings · {activeLlmFindings.length - visibleLlmCount} remaining</button>}

            {runtimeCombined.map((finding) => {
              const a = displayCards.find((card) => card.pr === finding.a);
              const b = displayCards.find((card) => card.pr === finding.b);
              if (!a || !b) return null;
              return (
                <article className={`conflictCard ${finding.verdict === "combined_clean" ? "combinedCleanCard" : finding.verdict === "combined_conflict" ? "combinedConflictCard" : "reviewCard"}`} key={`combined:${finding.a}:${finding.b}`}>
                  <div className="conflictStripe" />
                  <div className="cardTop"><span>{finding.verdict === "combined_clean" ? "안 충돌" : "충돌"}</span><b>COMBINED · ISOLATED A / B / A+B</b></div>
                  <div className="prPair">
                    <div><small>PR #{a.pr}</small><h3>{a.title}</h3></div><span className="collision">{finding.verdict === "combined_clean" ? "✓" : "×"}</span><div><small>PR #{b.pr}</small><h3>{b.title}</h3></div>
                  </div>
                  <p className="rationale">{finding.rationale}</p>
                  {!!finding.runs.length && <div className="evidence"><b>Execution results</b>{finding.runs.map((run) => <code key={run.label}>{run.label}: {run.status} · {Math.round(run.durationMs / 1000)}s · exit {run.exitCode ?? "none"}</code>)}</div>}
                  <div className="evidence"><b>Verification evidence</b>{finding.evidence.map((line) => <code key={line}>{line}</code>)}</div>
                </article>
              );
            })}

            {result.conflicts.map((conflict) => {
              const a = displayCards.find((card) => card.pr === conflict.a)!;
              const b = displayCards.find((card) => card.pr === conflict.b)!;
              return (
                <article className="conflictCard" key={`${conflict.a}:${conflict.b}`}>
                  <div className="conflictStripe" />
                  <div className="cardTop"><span>충돌</span><b>SEMANTIC · {conflict.evidenceLevel === "static_proof" ? "STATIC PROOF" : `${Math.round(conflict.confidence * 100)}% confidence`}</b></div>
                  <div className="prPair">
                    <div><small>PR #{a.pr}</small><h3>{a.title}</h3></div><span className="collision">×</span><div><small>PR #{b.pr}</small><h3>{b.title}</h3></div>
                  </div>
                  <div className="resourceRow"><span>SHARED CONTRACT</span>{conflict.sharedResources.map((resource) => <code key={resource}>{resource}</code>)}</div>
                  <p className="rationale">{conflict.rationale}</p>
                  <div className="evidence"><b>Evidence</b>{conflict.evidence.map((line) => <code key={line}>{line}</code>)}</div>
                </article>
              );
            })}

            {verificationFindings.map((finding) => {
              const a = displayCards.find((card) => card.pr === finding.a)!;
              const b = displayCards.find((card) => card.pr === finding.b)!;
              return (
                <article className="conflictCard reviewCard" key={`verify:${finding.a}:${finding.b}`}>
                  <div className="conflictStripe" />
                  <div className="cardTop"><span>충돌</span><b>SEMANTIC · {finding.evidenceStrength?.toUpperCase() ?? "UNRESOLVED"} EVIDENCE</b></div>
                  <div className="prPair">
                    <div><small>PR #{a.pr}</small><h3>{a.title}</h3></div><span className="collision">?</span><div><small>PR #{b.pr}</small><h3>{b.title}</h3></div>
                  </div>
                  <div className="resourceRow"><span>JOIN EVIDENCE</span>{finding.sharedResources.map((resource) => <code key={resource}>{resource}</code>)}</div>
                  <p className="rationale">{finding.rationale}</p>
                  <div className="evidence"><b>Why it was not auto-confirmed</b><code>{finding.reasonCode}</code>{finding.evidence.map((line) => <code key={line}>{line}</code>)}</div>
                </article>
              );
            })}

            <div className="nonConflict">
              <div><span className="check">✓</span><span><b>Evidence precedence</b><small>same-base Git merge → isolated A/B/A+B run → static proof → LLM risk 순으로 최종 판정을 갱신합니다.</small></span></div>
              <code>{result.pairMergePrs ?? result.cards.length} PRs → {pairTextConflicts.length} text · {combinedConflicts.length} combined · {llmConflicts.length} LLM</code>
            </div>
          </>
        )}
      </section>

      <footer><span>CONTRACT RADAR / v0.4</span><p>Dual indexes. Same-base merge. Differential execution.</p><span>GENERAL OSS PIPELINE</span></footer>
    </main>
  );
}
