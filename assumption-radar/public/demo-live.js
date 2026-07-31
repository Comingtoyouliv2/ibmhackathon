import { adaptBackendResponse, parseRepositoryInput } from "./demo-data.js";
import { verifiedCases } from "./verified-cases.js";

const $ = (selector) => document.querySelector(selector);
const state = { model: null, filter: "needs-action", graphFilter: "all", selected: null, view: "queue", activeCase: "zeppelin" };
const verdicts = {
  conflict: { label: "Conflict candidate", color: "#D6453A", badge: "candidate" },
  review: { label: "Needs review", color: "#DC9B00", badge: "stale" },
};
let progressTimer = null;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function setStatus(message, tone = "") {
  const element = $("#clone-status");
  element.className = `clone-status ${tone}`;
  element.textContent = message;
}

function updateProgress(percent, label, tone = "") {
  const progress = $("#analysis-progress");
  progress.hidden = false;
  progress.className = `analysis-progress ${tone}`;
  $("#progress-fill").style.width = `${percent}%`;
  $("#progress-percent").textContent = `${percent}%`;
  $("#progress-label").textContent = label;
}

function beginProgress() {
  clearInterval(progressTimer);
  let percent = 8;
  updateProgress(percent, "Fetching open pull requests");
  progressTimer = setInterval(() => {
    percent = Math.min(88, percent + (percent < 45 ? 7 : percent < 72 ? 4 : 2));
    const label = percent < 40
      ? "Fetching open pull requests"
      : percent < 72
        ? "Building cross-PR candidates"
        : "IBM Bob is judging candidate pairs";
    updateProgress(percent, label);
  }, 1_500);
}

function finishProgress(success) {
  clearInterval(progressTimer);
  progressTimer = null;
  updateProgress(100, success ? "Analysis complete" : "Analysis stopped", success ? "done" : "failed");
}

async function analyzeRepositoryWithBob(event) {
  event.preventDefault();
  const repositoryInput = $("#bob-repository");
  const apiKeyInput = $("#bob-api-key");
  const submit = $("#bob-analyze-submit");
  let repository;
  try {
    repository = parseRepositoryInput(repositoryInput.value);
  } catch (error) {
    setStatus(error.message, "err");
    repositoryInput.focus();
    return;
  }
  const bobApiKey = apiKeyInput.value.trim();
  if (!bobApiKey) {
    setStatus("Enter an IBM Bob API key.", "err");
    apiKeyInput.focus();
    return;
  }

  submit.disabled = true;
  $("#case-selector").disabled = true;
  setStatus(`Analyzing ${repository}. This can take several minutes.`, "warn");
  beginProgress();
  const requestBody = JSON.stringify({
    repository,
    limit: 20,
    useAI: true,
    aiProvider: "bob",
    bobApiKey,
    aiRepeats: 1,
    useMergePreflight: true,
    useVerification: false,
  });
  apiKeyInput.value = "";

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
      credentials: "same-origin",
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Analysis failed with HTTP ${response.status}.`);
    state.activeCase = "live";
    $("#case-selector").value = "custom";
    closeFindingModal();
    renderModel(adaptBackendResponse(result));
    finishProgress(true);
    setStatus(result.aiError
      ? `Repository analysis completed, but IBM Bob fell back to deterministic results: ${result.aiError}`
      : `IBM Bob analysis complete for ${repository}.`,
    result.aiError ? "warn" : "ok");
  } catch (error) {
    finishProgress(false);
    setStatus(error.message || "IBM Bob analysis failed.", "err");
  } finally {
    submit.disabled = false;
    $("#case-selector").disabled = false;
  }
}

function prById(id) {
  return state.model?.prs.find((pr) => pr.id === id);
}

function findingById(id) {
  return state.model?.findings.find((finding) => finding.id === id);
}

function renderFunnel() {
  const { summary } = state.model;
  const actionable = summary.conflictCount + summary.reviewCount;
  const steps = state.model.mode === "verified-case"
    ? [
        [summary.prCount, "Pull requests"],
        [summary.pairCount, "Relationships"],
        [summary.candidateCount, "Cross-checked"],
        [summary.aiReviewedPairCount, "Evidence-backed"],
        [actionable, "Findings"],
      ]
    : [
        [summary.prCount, "Open PRs"],
        [summary.pairCount, "Possible pairs"],
        [summary.candidateCount, "Candidate pairs"],
        [summary.aiReviewedPairCount, "AI reviewed"],
        [actionable, "Needs attention"],
      ];
  $("#funnel").innerHTML = steps.map(([number, label], index) => `
    <div class="fstep real ${index === steps.length - 1 ? "final" : ""}">
      <span class="num">${escapeHtml(number)}</span><span class="lbl">${escapeHtml(label)}</span>
    </div>`).join("");
}

function filteredFindings() {
  if (state.filter === "all" || state.filter === "needs-action") return state.model.findings;
  return state.model.findings.filter((finding) => finding.verdict === state.filter);
}

function filterButton(value, label, count) {
  return `<button class="fchip ${state.filter === value ? "active" : ""}" data-filter="${value}">${label} · ${count}</button>`;
}

function renderQueue() {
  const isVerifiedCase = state.model.mode === "verified-case";
  const conflicts = state.model.findings.filter((item) => item.verdict === "conflict");
  const reviews = state.model.findings.filter((item) => item.verdict === "review");
  const primary = conflicts[0] || reviews[0];
  const flaggedPrIds = new Set(state.model.findings.flatMap((finding) => finding.prIds));
  const noActionPrCount = Math.max(0, state.model.summary.prCount - flaggedPrIds.size);
  const context = `<details class="plan"><summary>${isVerifiedCase ? "Case evidence" : "Analysis coverage"} <span class="n">${isVerifiedCase ? "verified example" : `backend result · ${escapeHtml(state.model.mode)}`}</span></summary>
    <div class="plan-body"><div class="plan-sec"><div class="pl">Repository</div><code>${escapeHtml(state.model.repository)}</code></div>
    <div class="plan-sec"><div class="pl">Coverage</div>${state.model.summary.pairCount} total pair(s) · ${state.model.summary.candidateCount} candidate(s) · ${state.model.summary.independentCount} independent · ${state.model.summary.insufficientCount} insufficient</div>
    ${state.model.aiError ? `<div class="plan-sec"><div class="pl">AI fallback</div>${escapeHtml(state.model.aiError)}</div>` : ""}</div></details>`;
  const compactRow = (finding) => {
    const a = prById(finding.prIds[0]);
    const b = prById(finding.prIds[1]);
    const verdict = verdicts[finding.verdict];
    return `<button class="compact-row" data-finding="${escapeHtml(finding.id)}">
      <span class="cpair"><span class="vdot" style="background:${verdict.color}"></span>&nbsp; #${escapeHtml(a.num)} × #${escapeHtml(b.num)}</span>
      <span class="ctitle">${escapeHtml(finding.title)}</span>
      <span class="ctype">${escapeHtml(finding.categoryLabel)}</span>
    </button>`;
  };
  let hero = `<div class="qempty"><b>No relationship needs action.</b><br>All PRs remain available in the repository map.</div>`;
  if (primary) {
    const a = prById(primary.prIds[0]);
    const b = prById(primary.prIds[1]);
    const verdict = verdicts[primary.verdict];
    const runCount = primary.verification?.runs?.length || 0;
    const executionLabel = runCount ? `${runCount} verification check(s) available` : "Verification not attached";
    hero = `<article class="priority-hero ${primary.verdict === "review" ? "review-hero" : ""}" data-finding="${escapeHtml(primary.id)}">
      <div class="hero-top"><span class="vdot" style="background:${verdict.color}"></span><span class="eyebrow">${escapeHtml(verdict.label)} · check first</span><span class="pair">#${escapeHtml(a.num)} × #${escapeHtml(b.num)}</span><span class="spacer"></span><span class="badge ${verdict.badge}">${escapeHtml(primary.mergeTree === "clean" ? "CLEAN MERGE" : primary.mergeTree === "textual-conflict" ? "GIT TEXT CONFLICT" : "PREFLIGHT UNKNOWN")}</span></div>
      <div class="hero-body">
        <h3>${escapeHtml(primary.title)}</h3>
        <div class="hero-summary">${escapeHtml(primary.summary)}</div>
        <div class="contract-flow">
          <div class="contract-card"><span class="clabel">PR #${escapeHtml(a.num)} assumption</span>${escapeHtml(primary.assumptionA)}</div>
          <div class="flow-arrow">→</div>
          <div class="contract-card"><span class="clabel">PR #${escapeHtml(b.num)} change / assumption</span>${escapeHtml(primary.assumptionB)}</div>
        </div>
        <div class="impact-card"><b>If merged together</b>${escapeHtml(primary.consequence)}</div>
        <div class="hero-actions"><button class="primary" data-open-finding="${escapeHtml(primary.id)}">View code evidence</button><span class="verify-state">${escapeHtml(executionLabel)}</span></div>
      </div>
    </article>`;
  }
  const reviewRows = reviews.length
    ? `<div class="compact-list">${reviews.slice(0, 6).map(compactRow).join("")}${reviews.length > 6 ? `<details class="more-results"><summary>Show ${reviews.length - 6} more review pair(s)</summary>${reviews.slice(6).map(compactRow).join("")}</details>` : ""}</div>`
    : `<div class="qempty">No additional review pair was returned.</div>`;
  $("#queue-wrap").innerHTML = `
    <section class="scan-overview">
      <div class="scan-title"><h2>${isVerifiedCase ? "Verified case in repository context" : "Scan result"}</h2><p>${isVerifiedCase ? `${escapeHtml(state.model.summary.prCount)} pull requests · ${escapeHtml(state.model.summary.pairCount)} relationships scanned` : `${escapeHtml(state.model.summary.prCount)} open PRs · ${escapeHtml(state.model.summary.pairCount)} possible pairs analyzed`}</p></div>
      <div class="scan-kpis">
        <div class="scan-kpi danger"><div class="klabel"><span class="vdot" style="background:${verdicts.conflict.color}"></span>Conflict candidate</div><div class="knum">${conflicts.length}<span class="kunit">pair(s)</span></div></div>
        <div class="scan-kpi warning"><div class="klabel"><span class="vdot" style="background:${verdicts.review.color}"></span>Needs review</div><div class="knum">${reviews.length}<span class="kunit">pair(s)</span></div></div>
        <div class="scan-kpi"><div class="klabel"><span class="vdot" style="background:#AAB4BC"></span>No action found</div><div class="knum">${noActionPrCount}<span class="kunit">PR(s)</span></div></div>
      </div>
    </section>
    ${hero}
    <section class="action-section"><div class="section-hd"><h3>Needs review</h3><span>${reviews.length} pair(s) requiring human judgment</span></div>${reviewRows}</section>
    <div class="map-strip"><div class="map-copy"><b>${isVerifiedCase ? "Change relationship map" : "Repository relationship map"}</b>See ${isVerifiedCase ? "how the two PRs connect through shared code and contracts" : `all ${escapeHtml(state.model.summary.prCount)} PRs grouped by repository sector while conflict and review candidates stay highlighted`}.</div><button class="map-cta" data-switch-graph>View relationship map →</button></div>
    ${context}`;
  $("#queue-wrap").querySelectorAll("[data-finding]").forEach((row) => row.addEventListener("click", () => select("finding", row.dataset.finding)));
  $("#queue-wrap").querySelectorAll("[data-open-finding]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    select("finding", button.dataset.openFinding);
  }));
  $("#queue-wrap").querySelector("[data-switch-graph]")?.addEventListener("click", () => switchView("graph"));
}

function renderEmptyDetail() {
  $("#side-hd").innerHTML = `<span class="title">Case evidence</span><span class="mono">${escapeHtml(state.model.repository)}</span>`;
  $("#side-body").innerHTML = `<div class="empty">Select the finding, a PR node, or a shared contract to inspect the evidence behind this verified case.</div>`;
}

function renderGraphFilterDetail(filter) {
  const filterOrder = filter === "all" ? ["conflict", "review"] : [filter];
  const findings = filterOrder.flatMap((key) => state.model.findings.filter((finding) => finding.verdict === key));
  const guidance = {
    all: {
      title: "All findings",
      text: "Start with the verified conflict candidate, then inspect the small needs-review queue. Select any pair to open its evidence in a separate detail window.",
    },
    conflict: {
      title: "What to check first",
      text: "Open the highest-impact pair, verify the two stated assumptions against code evidence, then check whether Base/A/B/A+B execution has confirmed a combined-only failure.",
    },
    review: {
      title: "What needs human judgment",
      text: "Confirm whether the relationship is causal rather than simple proximity. Look for missing execution evidence, ambiguous intent, or an unsupported contract inference.",
    },
  }[filter];
  const headerLabel = filter === "all" ? "All findings" : verdicts[filter].label;
  const headerDot = filter === "all" ? "" : `<span class="vdot" style="background:${verdicts[filter].color}"></span>`;
  const renderStackItem = (finding, index) => {
    const a = prById(finding.prIds[0]);
    const b = prById(finding.prIds[1]);
    const verdict = verdicts[finding.verdict];
    return `<button class="stack-item filter-stack-item" data-finding="${escapeHtml(finding.id)}">
      <div class="top"><span class="stack-rank">${index + 1}</span><span class="vdot" style="background:${verdict.color}"></span><span class="prn">#${escapeHtml(a.num)} × #${escapeHtml(b.num)}</span><span class="vlabel" style="color:${verdict.color}">${escapeHtml(finding.mergeTree === "clean" ? "CLEAN" : finding.mergeTree === "textual-conflict" ? "GIT" : "UNKNOWN")}</span></div>
      <div class="ttl">${escapeHtml(finding.title)}</div>
      <div class="meta">${escapeHtml(finding.categoryLabel)} · ${escapeHtml(finding.basis)}</div>
      <div class="human">Inspect: ${escapeHtml(finding.recommendation)}</div>
    </button>`;
  };
  $("#side-hd").innerHTML = `${headerDot}<span class="title">${escapeHtml(headerLabel)}</span><span class="mono">${findings.length} pair(s)</span>`;
  $("#side-body").innerHTML = `
    <div class="callout blue"><b>${escapeHtml(guidance.title)}</b><br>${escapeHtml(guidance.text)}</div>
    ${findings.length ? filterOrder.map((key) => {
      const group = findings.filter((finding) => finding.verdict === key);
      if (!group.length) return "";
      return `<div class="sec-title stack-section-title"><span class="vdot" style="background:${verdicts[key].color}"></span>${escapeHtml(verdicts[key].label)} · ${group.length}</div>${group.map(renderStackItem).join("")}`;
    }).join("") : `<div class="empty">No pair was returned in this category.</div>`}`;
  $("#side-body").querySelectorAll("[data-finding]").forEach((button) => button.addEventListener("click", () => select("finding", button.dataset.finding)));
}

function closeFindingModal() {
  $("#overlay").classList.remove("open");
  $("#modal").innerHTML = "";
  state.selected = null;
}

function renderFindingDetail(finding) {
  const a = prById(finding.prIds[0]);
  const b = prById(finding.prIds[1]);
  const verdict = verdicts[finding.verdict];
  const evidenceDetails = finding.evidenceDetails?.length
    ? finding.evidenceDetails
    : finding.evidence.map((text, index) => ({ id: `E${index + 1}`, side: "", file: "", symbol: "", line: "", text }));
  const renderEvidenceRow = (item, index) => {
    const normalizedSide = String(item.side || "").toUpperCase();
    const sideLabel = normalizedSide === "A" || normalizedSide.includes("PR-A")
      ? `PR #${a.num}`
      : normalizedSide === "B" || normalizedSide.includes("PR-B")
        ? `PR #${b.num}`
        : index === 0
          ? `PR #${a.num}`
          : index === 1
            ? `PR #${b.num}`
            : "Supporting";
    const location = [item.file, item.symbol, item.line ? `line ${item.line}` : ""].filter(Boolean).join(" · ");
    return `<details class="evidence-row">
      <summary><span class="evidence-id">${escapeHtml(item.id)}</span><b>${escapeHtml(sideLabel)}</b>${location ? `<span class="evidence-location-inline" title="${escapeHtml(location)}">${escapeHtml(location)}</span>` : ""}<span class="evidence-expand"><span class="show-label">View</span><span class="hide-label">Hide</span></span></summary>
      <div class="evidence-quote">${escapeHtml(item.text)}</div>
    </details>`;
  };
  const renderAnalyzerRow = (item, index) => `<details class="evidence-row explanation-row">
    <summary>
      <span class="evidence-id analyzer-id">A${index + 1}</span>
      <b>${escapeHtml(item.title)}</b>
      ${item.strength == null ? "" : `<span class="evidence-location-inline">${escapeHtml(item.strength)}</span>`}
      <span class="evidence-expand"><span class="show-label">View</span><span class="hide-label">Hide</span></span>
    </summary>
    <div class="evidence-quote">${escapeHtml(item.explanation)}</div>
  </details>`;
  const primaryEvidence = [
    ...evidenceDetails.slice(0, 2).map(renderEvidenceRow),
    ...finding.witnesses.slice(0, 1).map(renderAnalyzerRow),
  ].join("");
  const remainingEvidence = [
    ...evidenceDetails.slice(2).map((item, index) => renderEvidenceRow(item, index + 2)),
    ...finding.witnesses.slice(1).map((item, index) => renderAnalyzerRow(item, index + 1)),
  ].join("");
  const remainingEvidenceCount = Math.max(0, evidenceDetails.length - 2) + Math.max(0, finding.witnesses.length - 1);
  const totalEvidenceCount = evidenceDetails.length + finding.witnesses.length;
  const evidenceSummary = totalEvidenceCount
    ? `<div class="evidence-summary-bar">
        <span>${evidenceDetails.length} code ref${evidenceDetails.length === 1 ? "" : "s"}</span>
        <span>${finding.witnesses.length} analyzer signal${finding.witnesses.length === 1 ? "" : "s"}</span>
        <span class="summary-help">Click a row to expand</span>
      </div>
      ${primaryEvidence}
      ${remainingEvidence ? `<details class="evidence-more evidence-all"><summary>View all ${remainingEvidenceCount} remaining evidence item${remainingEvidenceCount === 1 ? "" : "s"}</summary>${remainingEvidence}</details>` : ""}`
    : `<div class="empty">No concrete evidence was returned. Treat this finding as a review hypothesis until evidence is attached.</div>`;
  const verificationRuns = finding.verification?.runs || [];
  const verificationSummary = verificationRuns.length
    ? `<div class="verification-grid">${verificationRuns.map((run) => {
        const status = String(run.status || "");
        const isFailure = /fail|error|http 4|rejected/i.test(status);
        return `<div class="verification-item ${isFailure ? "fail" : ""}">
          <span class="vlabel">${escapeHtml(String(run.label || "check").replaceAll("_", " "))}</span>
          <span class="vstatus">${escapeHtml(status)}</span>
        </div>`;
      }).join("")}</div>
      <div class="verification-note">${state.activeCase === "zeppelin"
        ? "The client and server contract was replayed at the affected endpoint. This is not a claim that the full Zeppelin integration suite was executed."
        : "The same combined diagnostic mismatch was reproduced in both merge orders."}</div>`
    : `<div class="empty">No executable or contract-replay status was attached to this finding.</div>`;
  $("#modal").innerHTML = `
    <div class="modal-hd">
      <span class="vbadge" style="background:${verdict.color}">${escapeHtml(verdict.label)}</span>
      <span class="pairname"><a href="${escapeHtml(a.url || "#")}" target="_blank" rel="noreferrer">#${escapeHtml(a.num)}</a> × <a href="${escapeHtml(b.url || "#")}" target="_blank" rel="noreferrer">#${escapeHtml(b.num)}</a></span>
      <span class="fresh">${escapeHtml(finding.categoryLabel)} · ${escapeHtml(finding.mergeTree === "clean" ? "clean merge" : finding.mergeTree || "preflight unknown")}</span>
      <button class="xbtn modal-close" data-close-modal aria-label="Close detail">×</button>
    </div>
    <div class="modal-body">
      <div class="kv"><b>${escapeHtml(finding.title)}</b><br><span class="chip">${escapeHtml(finding.basis)}</span><span class="chip">${escapeHtml(finding.source)}</span></div>
      <div class="sec-title">Backend summary</div><div class="callout blue">${escapeHtml(finding.summary)}</div>
      <div class="sec-title">Hidden assumptions</div>
      <div class="assump" style="border-left-color:${verdict.color}"><span class="atype">PR #${escapeHtml(a.num)}</span>${escapeHtml(finding.assumptionA)}</div>
      <div class="assump" style="border-left-color:${verdict.color}"><span class="atype">PR #${escapeHtml(b.num)}</span>${escapeHtml(finding.assumptionB)}</div>
      <div class="sec-title">If merged together</div><div class="callout red">${escapeHtml(finding.consequence)}</div>
      <div class="sec-title">Recommended action</div><div class="callout blue">${escapeHtml(finding.recommendation)}</div>
      <div class="sec-title">Verification status</div>${verificationSummary}
      <div class="sec-title">Why these changes connect</div>
      <div class="connection-explanation"><b>PR #${escapeHtml(a.num)}</b> relies on “${escapeHtml(finding.assumptionA)}” while <b>PR #${escapeHtml(b.num)}</b> introduces or relies on “${escapeHtml(finding.assumptionB)}”. The analyzer linked the pair because these expectations meet in the same code path or contract and may produce: <b>${escapeHtml(finding.consequence)}</b></div>
      <div class="sec-title">Evidence summary</div>${evidenceSummary}
    </div>
    <div class="modal-ft"><span class="note">The findings list stays open behind this window so you can review the next pair after closing.</span><button class="act" data-close-modal>Close</button></div>`;
  $("#overlay").classList.add("open");
  $("#modal").querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeFindingModal));
  $("#modal [data-close-modal]")?.focus();
}

function renderPrDetail(pr) {
  const related = state.model.findings.filter((finding) => finding.prIds.includes(pr.id));
  $("#side-hd").innerHTML = `<span class="title">PR #${escapeHtml(pr.num)}</span><button class="xbtn" aria-label="Close">×</button>`;
  $("#side-body").innerHTML = `<div class="kv"><b>${escapeHtml(pr.title)}</b><br>Author: ${escapeHtml(pr.author)} · ${pr.nFiles} changed file(s)<br>${pr.url ? `<a href="${escapeHtml(pr.url)}" target="_blank" rel="noreferrer">Open on GitHub ↗</a>` : ""}</div>
    <div class="sec-title">Assumptions extracted by backend</div>${pr.assumptions.length ? pr.assumptions.map((item) => `<div class="assump"><span class="atype">${escapeHtml(item.type)}</span>${escapeHtml(item.text)}${item.anchor ? `<div class="anchor">${escapeHtml(item.anchor)}</div>` : ""}</div>`).join("") : `<div class="empty">No explicit assumption card was returned.</div>`}
    <div class="sec-title">Related findings</div>${related.length ? related.map((finding) => `<button class="stack-item" data-finding="${escapeHtml(finding.id)}"><div class="top"><span class="vdot" style="background:${verdicts[finding.verdict].color}"></span><span class="prn">${escapeHtml(verdicts[finding.verdict].label)}</span></div><div class="ttl">${escapeHtml(finding.title)}</div></button>`).join("") : `<div class="empty">No actionable relationship was returned for this PR.</div>`}`;
  $("#side-hd .xbtn").addEventListener("click", () => select("none"));
  $("#side-body").querySelectorAll("[data-finding]").forEach((button) => button.addEventListener("click", () => select("finding", button.dataset.finding)));
}

function renderResourceDetail(resource) {
  const prs = resource.prIds.map(prById).filter(Boolean);
  $("#side-hd").innerHTML = `<span class="title">Shared resource</span><button class="xbtn" aria-label="Close">×</button>`;
  $("#side-body").innerHTML = `<div class="kv"><b>${escapeHtml(resource.path)}</b><br>${prs.length} PR(s) connected</div><div class="sec-title">Pull requests</div>${prs.map((pr) => `<button class="stack-item" data-pr="${escapeHtml(pr.id)}"><div class="top"><span class="prn">#${escapeHtml(pr.num)}</span></div><div class="ttl">${escapeHtml(pr.title)}</div></button>`).join("")}`;
  $("#side-hd .xbtn").addEventListener("click", () => select("none"));
  $("#side-body").querySelectorAll("[data-pr]").forEach((button) => button.addEventListener("click", () => select("pr", button.dataset.pr)));
}

function select(type, id) {
  state.selected = type === "none" ? null : { type, id };
  if (type === "finding") renderFindingDetail(findingById(id));
  else if (type === "pr") renderPrDetail(prById(id));
  else if (type === "resource") renderResourceDetail(state.model.resources.find((item) => item.id === id));
  else renderEmptyDetail();
}

function renderLegend(showResources = true) {
  $("#legend").innerHTML = `<div class="row"><b>How to read</b></div>` + Object.entries(verdicts).map(([, item]) => `<div class="row"><span class="vdot" style="background:${item.color}"></span>${item.label}</div>`).join("") + `<div class="row"><span class="vdot" style="background:#AAB4BC"></span>No action found</div><div class="row"><b>Blue dotted ring</b> verified case</div><div class="row">○ PR${showResources ? " &nbsp; □ shared file / contract" : " &nbsp; — relationship"}</div>`;
}

function graphFindings() {
  if (state.graphFilter === "all") return state.model.findings;
  return state.model.findings.filter((finding) => finding.verdict === state.graphFilter);
}

function renderGraphPriority() {
  const counts = Object.fromEntries(Object.keys(verdicts).map((key) => [key, state.model.findings.filter((item) => item.verdict === key).length]));
  const hidden = Math.max(0, state.model.prs.length - new Set(graphFindings().flatMap((finding) => finding.prIds)).size);
  const button = (filter, title, count, color) => `<button class="graph-focus ${state.graphFilter === filter ? "active" : ""}" data-graph-filter="${filter}"><span class="gf-top"><span class="vdot" style="background:${color}"></span>${title}</span><span class="gf-count">${count}</span></button>`;
  $("#graph-priority").innerHTML = [
    button("all", "All PRs", state.model.prs.length, "#0F62FE"),
    button("conflict", "Conflict candidates", counts.conflict, verdicts.conflict.color),
    button("review", "Needs review", counts.review, verdicts.review.color),
    state.graphFilter === "all" ? "" : `<span class="graph-hidden-note">${hidden} unrelated PR(s) hidden</span>`,
  ].join("");
  $("#graph-priority").querySelectorAll("[data-graph-filter]").forEach((control) => control.addEventListener("click", () => {
    state.graphFilter = control.dataset.graphFilter;
    state.selected = null;
    renderGraphFilterDetail(state.graphFilter);
    renderGraph();
  }));
}

function sectorForPath(rawPath = "") {
  const input = String(rawPath);
  const path = input.replace(/^(?:contract|file):/, "");
  if (input.startsWith("contract:")) return `CONTRACT · ${(path || "SEMANTIC").toUpperCase()}`;
  if (!path || !path.includes("/")) {
    if (/^(?:api|data|config|auth|event|rollout|behavior|code|semantic-contract)$/i.test(path)) return `CONTRACT · ${path.toUpperCase()}`;
    return path ? "ROOT" : "UNMAPPED";
  }
  const parts = path.replace(/^\.?\//, "").split("/").filter(Boolean);
  const first = parts[0] || "root";
  if (/^(?:test|tests|spec|specs|testing)$/i.test(first)) return "TESTS";
  if (/^(?:doc|docs|documentation)$/i.test(first)) return "DOCS";
  if (/^(?:\.github|ci|build|scripts|tools|config)$/i.test(first)) return first.toUpperCase();
  if (/^(?:src|lib|packages|apps|modules|plugins|extensions)$/i.test(first) && parts[1]) {
    return `${first}/${parts[1]}`.toUpperCase();
  }
  return first.toUpperCase();
}

function dominantSector(paths = []) {
  const counts = new Map();
  for (const path of paths) {
    const sector = sectorForPath(path);
    counts.set(sector, (counts.get(sector) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || "UNMAPPED";
}

function sectorTone(name) {
  const palette = [
    ["#E8F1FF", "#78A9FF", "#0043CE"],
    ["#E6F6F2", "#42BEA6", "#005D5D"],
    ["#F7E8F4", "#D4A6C8", "#9F1853"],
    ["#FFF3D6", "#F1C21B", "#8E6A00"],
    ["#F0E9FF", "#BE95FF", "#6929C4"],
    ["#E5F6FF", "#82CFFF", "#00539A"],
    ["#FDE8E6", "#FF8389", "#A2191F"],
    ["#EAF4DF", "#8DBD5F", "#3A6D0B"],
  ];
  let hash = 2166136261;
  for (const char of String(name)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return palette[(hash >>> 0) % palette.length];
}

function renderGraph() {
  if (!window.d3 || !state.model) return;
  const svg = window.d3.select("#graph");
  svg.selectAll("*").remove();
  const node = $("#graph");
  const width = Math.max(640, node.clientWidth || 900);
  const height = Math.max(480, node.clientHeight || 620);
  svg.attr("viewBox", `0 0 ${width} ${height}`);
  const findings = graphFindings();
  const priorityFindings = state.model.findings.filter((finding) => finding.verdict === "conflict" || finding.verdict === "review");
  const priorityPrIds = new Set(priorityFindings.flatMap((finding) => finding.prIds));
  const priorityResourcePaths = new Set(priorityFindings.flatMap((finding) => finding.resources));
  const focusPrIds = new Set(findings.flatMap((finding) => finding.prIds));
  const findingResourcePaths = new Set(findings.flatMap((finding) => finding.resources));
  const prs = state.graphFilter === "all" ? state.model.prs : state.model.prs.filter((pr) => focusPrIds.has(pr.id));
  const visiblePrIds = new Set(prs.map((pr) => pr.id));
  const resources = state.graphFilter === "all" ? [] : state.model.resources.filter((resource) => {
    const visibleUsers = resource.prIds.filter((id) => visiblePrIds.has(id)).length;
    return visibleUsers > 1 && findingResourcePaths.has(resource.path);
  }).slice(0, 24);
  const nodes = [
    ...prs.map((pr) => ({ ...pr, kind: "pr", sector: dominantSector(pr.paths), priority: priorityPrIds.has(pr.id) })),
    ...resources.map((resource) => ({ ...resource, kind: "resource", sector: sectorForPath(resource.path), priority: priorityResourcePaths.has(resource.path) })),
  ];
  const links = [];
  // A focused graph intentionally hides unrelated PRs. Only create resource
  // links for PR nodes that are still visible; d3.forceLink throws when a link
  // points at a filtered-out node and used to leave the whole graph blank.
  resources.forEach((resource) => resource.prIds
    .filter((prId) => visiblePrIds.has(prId))
    .forEach((prId) => links.push({ source: prId, target: resource.id, kind: "resource" })));
  findings.forEach((finding) => links.push({ source: finding.prIds[0], target: finding.prIds[1], kind: "finding", finding }));
  renderGraphPriority();
  renderLegend(state.graphFilter !== "all");
  if (!nodes.length) {
    $("#graph-hint").textContent = "No relationship in this filter. Choose another category or All context.";
    return;
  }
  const stableUnit = (value, salt = 0) => {
    let hash = 2166136261 + salt;
    for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return (hash >>> 0) / 4294967295;
  };
  const isAll = state.graphFilter === "all";
  const sectorTop = 112;
  const sectorInset = 8;
  // Reserve a dedicated footer for the compact legend so it never covers PR nodes.
  const sectorBottom = 62;
  const sectorGroups = [...window.d3.group(nodes, (item) => item.sector).entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const sectorRoot = window.d3.hierarchy({
    children: sectorGroups.map(([name, items]) => ({ name, items, value: Math.max(2, items.length) })),
  }).sum((item) => item.value || 0);
  const layoutWidth = Math.max(1, width - sectorInset * 2);
  const layoutHeight = Math.max(1, height - sectorTop - sectorBottom);
  window.d3.treemap()
    .size([layoutWidth, layoutHeight])
    .paddingInner(10)
    .paddingOuter(3)
    .round(true)(sectorRoot);
  const nodeScale = Math.max(.58, Math.min(1, Math.sqrt(48 / Math.max(1, nodes.length))));
  const fitSectorText = (text, radius, offset, maxFont, minFont) => {
    const chordWidth = Math.max(18, 2 * Math.sqrt(Math.max(0, radius ** 2 - (radius - offset) ** 2)) - 12);
    const fontSize = Math.max(minFont, Math.min(maxFont, chordWidth / Math.max(1, text.length * .62)));
    const maxCharacters = Math.max(3, Math.floor(chordWidth / (fontSize * .62)));
    if (text.length <= maxCharacters) return { text, fontSize };
    const remaining = maxCharacters - 1;
    const start = Math.max(1, Math.ceil(remaining * .58));
    const end = Math.max(1, remaining - start);
    return { text: `${text.slice(0, start)}…${text.slice(-end)}`, fontSize };
  };
  const sectorLayout = new Map(sectorRoot.leaves().map((leaf) => [leaf.data.name, {
    cx: (leaf.x0 + leaf.x1) / 2 + sectorInset,
    cy: (leaf.y0 + leaf.y1) / 2 + sectorTop,
    r: Math.max(8, Math.min(leaf.x1 - leaf.x0, leaf.y1 - leaf.y0) / 2 - 3),
    count: leaf.data.items.length,
    prCount: leaf.data.items.filter((item) => item.kind === "pr").length,
    priorityCount: leaf.data.items.filter((item) => item.kind === "pr" && item.priority).length,
    tone: sectorTone(leaf.data.name),
  }]));
  sectorGroups.forEach(([name, items]) => {
    const sector = sectorLayout.get(name);
    const ordered = [...items].sort((a, b) => Number(b.priority) - Number(a.priority)
      || (a.kind === "pr" ? a.num : a.id).toString().localeCompare((b.kind === "pr" ? b.num : b.id).toString(), undefined, { numeric: true }));
    const availableRadius = Math.max(10, sector.r - (24 * nodeScale + 14));
    const phase = stableUnit(name, 43) * Math.PI * 2;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    ordered.forEach((item, index) => {
      const radius = index === 0 ? 0 : Math.sqrt(index / Math.max(1, ordered.length)) * availableRadius;
      const angle = phase + index * goldenAngle;
      item.homeX = sector.cx + Math.cos(angle) * radius;
      item.homeY = sector.cy + 9 + Math.sin(angle) * radius;
      item.x = item.homeX + (stableUnit(item.id, 17) - .5) * 8;
      item.y = item.homeY + (stableUnit(item.id, 71) - .5) * 8;
    });
  });
  const simulation = window.d3.forceSimulation(nodes)
    .force("link", window.d3.forceLink(links).id((item) => item.id).distance((link) => (link.kind === "finding" ? 110 : 48) * nodeScale).strength((link) => link.kind === "finding" ? .025 : .08))
    .force("charge", window.d3.forceManyBody().strength((item) => (item.priority ? -38 : -10) * nodeScale))
    .force("sector-x", window.d3.forceX((item) => item.homeX).strength(.62))
    .force("sector-y", window.d3.forceY((item) => item.homeY).strength(.62))
    .force("collision", window.d3.forceCollide().radius((item) => (item.kind === "pr" ? (item.priority ? 20 : 11) : (item.priority ? 10 : 7)) * nodeScale));
  const viewport = svg.append("g");
  svg.call(window.d3.zoom().scaleExtent([.4, 3]).on("zoom", (event) => viewport.attr("transform", event.transform)));
  const sectorLayer = viewport.append("g").attr("class", "sector-layer");
  const sectorCards = sectorLayer.selectAll("g").data([...sectorLayout.entries()]).join("g").attr("class", "sector-card");
  sectorCards.append("circle")
    .attr("cx", ([, sector]) => sector.cx)
    .attr("cy", ([, sector]) => sector.cy)
    .attr("r", ([, sector]) => sector.r)
    .attr("fill", ([, sector]) => sector.tone[0])
    .attr("stroke", ([, sector]) => sector.tone[1]);
  sectorCards.append("text")
    .attr("class", "sector-title")
    .attr("x", ([, sector]) => sector.cx)
    .attr("y", ([, sector]) => sector.cy - sector.r + 20)
    .attr("text-anchor", "middle")
    .style("font-size", ([name, sector]) => `${fitSectorText(name, sector.r, 20, 10, 6.5).fontSize}px`)
    .attr("fill", ([, sector]) => sector.tone[2])
    .text(([name, sector]) => fitSectorText(name, sector.r, 20, 10, 6.5).text);
  sectorCards.append("text")
    .attr("class", "sector-meta")
    .attr("x", ([, sector]) => sector.cx)
    .attr("y", ([, sector]) => sector.cy - sector.r + 35)
    .attr("text-anchor", "middle")
    .style("font-size", ([, sector]) => {
      const label = `${sector.prCount} PR${sector.prCount === 1 ? "" : "S"}${sector.priorityCount ? ` · ${sector.priorityCount} FLAGGED` : ""}`;
      return `${fitSectorText(label, sector.r, 35, 8.5, 6).fontSize}px`;
    })
    .attr("fill", ([, sector]) => sector.tone[2])
    .text(([, sector]) => {
      const label = `${sector.prCount} PR${sector.prCount === 1 ? "" : "S"}${sector.priorityCount ? ` · ${sector.priorityCount} FLAGGED` : ""}`;
      return fitSectorText(label, sector.r, 35, 8.5, 6).text;
    });
  sectorCards.append("title").text(([name]) => name);
  const link = viewport.append("g").selectAll("line").data(links).join("line")
    .attr("stroke", (item) => item.kind === "finding" ? verdicts[item.finding.verdict].color : "#C8D0D5")
    .attr("stroke-width", (item) => item.kind === "finding"
      ? (item.finding.verdict === "conflict" || item.finding.verdict === "review" ? 2 : 1.5) * nodeScale
      : 1)
    .attr("stroke-dasharray", (item) => item.kind === "resource" ? "3 4" : null)
    .attr("opacity", (item) => item.kind === "finding" ? (item.finding.verified ? 1 : item.finding.verdict === "conflict" ? .72 : item.finding.verdict === "review" ? .76 : .5) : (isAll ? .18 : .5))
    .style("cursor", (item) => item.kind === "finding" ? "pointer" : "default")
    .on("click", (_, item) => { if (item.kind === "finding") select("finding", item.finding.id); });
  link.filter((item) => item.kind === "finding").append("title").text((item) => `${verdicts[item.finding.verdict].label}: ${item.finding.title}`);
  const groups = viewport.append("g").selectAll("g").data(nodes).join("g").attr("class", (item) => `node ${item.priority ? "priority-node" : "context-node"}`)
    .call(window.d3.drag().on("start", (event, item) => { if (!event.active) simulation.alphaTarget(.3).restart(); item.fx = item.x; item.fy = item.y; })
      .on("drag", (event, item) => { item.fx = event.x; item.fy = event.y; })
      .on("end", (event, item) => { if (!event.active) simulation.alphaTarget(0); item.fx = null; item.fy = null; }));
  const prVerdict = (prId) => findings.find((finding) => finding.prIds.includes(prId) && finding.verdict === "conflict")?.verdict
    || findings.find((finding) => finding.prIds.includes(prId) && finding.verdict === "review")?.verdict;
  groups.filter((item) => item.kind === "pr").append("circle")
    .attr("r", (item) => (prVerdict(item.id) === "conflict" ? 15.5 : prVerdict(item.id) === "review" ? 13.5 : 5.75) * nodeScale)
    .attr("fill", (item) => verdicts[prVerdict(item.id)]?.color || "#AAB4BC")
    .attr("stroke", "#fff").attr("stroke-width", (item) => (item.priority ? 3 : 2) * nodeScale).attr("opacity", (item) => item.priority ? 1 : .62);
  const verifiedPr = (prId) => findings.some((finding) => finding.verified && finding.prIds.includes(prId));
  groups.filter((item) => item.kind === "pr" && verifiedPr(item.id)).append("circle")
    .attr("r", 20 * nodeScale)
    .attr("fill", "none")
    .attr("stroke", "#0F62FE")
    .attr("stroke-width", 2.4 * nodeScale)
    .attr("stroke-dasharray", `${3 * nodeScale} ${2 * nodeScale}`);
  const resourceNodeSize = (item) => Math.min(14, 6 + item.total * 1.5) * nodeScale;
  groups.filter((item) => item.kind === "resource").append("rect")
    .attr("x", (item) => -resourceNodeSize(item) / 2)
    .attr("y", (item) => -resourceNodeSize(item) / 2)
    .attr("width", resourceNodeSize)
    .attr("height", resourceNodeSize)
    .attr("rx", 2)
    .attr("fill", "#fff")
    .attr("stroke", (item) => item.priority ? "#5C6B78" : "#AAB4BC")
    .attr("stroke-width", .8)
    .attr("opacity", (item) => item.priority ? .9 : .36);
  groups.append("title").text((item) => item.kind === "pr" ? `PR #${item.num}: ${item.title}` : item.path);
  groups.on("click", (_, item) => select(item.kind, item.id));
  simulation.on("tick", () => {
    nodes.forEach((item) => {
      const sector = sectorLayout.get(item.sector);
      const margin = (item.priority ? 20 : 12) * nodeScale;
      const dx = item.x - sector.cx;
      const dy = item.y - sector.cy;
      const distance = Math.hypot(dx, dy);
      const maxDistance = Math.max(4, sector.r - margin);
      if (distance > maxDistance) {
        item.x = sector.cx + (dx / distance) * maxDistance;
        item.y = sector.cy + (dy / distance) * maxDistance;
      }
    });
    link.attr("x1", (item) => item.source.x).attr("y1", (item) => item.source.y).attr("x2", (item) => item.target.x).attr("y2", (item) => item.target.y);
    groups.attr("transform", (item) => `translate(${item.x},${item.y})`);
  });
  $("#graph-hint").textContent = findings.length
    ? state.graphFilter === "all"
      ? `All ${state.model.prs.length} PRs are shown. Start with red and amber nodes: each island is a code area, colored lines connect PRs that may interact, and gray dots have no current finding.`
      : `${findings.length} prioritized relationship(s) shown. Conflict is highest priority, followed by needs-review candidates.`
    : "No relationship in this filter. Choose another category or All context.";
}

function switchView(view) {
  state.view = view;
  $("#queue-wrap").style.display = view === "queue" ? "block" : "none";
  $("#graph-wrap").style.display = view === "graph" ? "block" : "none";
  $("#tab-queue").classList.toggle("active", view === "queue");
  $("#tab-graph").classList.toggle("active", view === "graph");
  if (view === "graph") {
    renderGraphFilterDetail(state.graphFilter);
    requestAnimationFrame(renderGraph);
  }
}

function renderModel(model) {
  state.model = model;
  state.selected = null;
  state.graphFilter = "all";
  $("#repo-label").textContent = model.repository;
  $("#store-note").textContent = model.mode === "verified-case"
    ? `${model.findings.length} scanned relationship(s) · 1 verified case`
    : `${model.findings.length} backend finding(s)`;
  renderFunnel();
  renderQueue();
  renderGraphFilterDetail("all");
  if (state.view === "graph") renderGraph();
}

function loadVerifiedCase(caseKey) {
  const selectedCase = verifiedCases[caseKey];
  if (!selectedCase) return;
  state.activeCase = caseKey;
  $("#case-selector").value = caseKey;
  $("#bob-analyze-form").hidden = true;
  closeFindingModal();
  renderModel(adaptBackendResponse(selectedCase));
  setStatus(caseKey === "zeppelin"
    ? "Verified example: a Python client and Java server disagree on the same restart contract."
    : "Verified example: two individually passing mypy changes produce a repeatable combined test failure.", "ok");
}

function chooseAnalysisSource(source) {
  if (source === "custom") {
    $("#bob-analyze-form").hidden = false;
    $("#analysis-progress").hidden = true;
    setStatus("Enter a public GitHub repository and your IBM Bob API key.", "");
    requestAnimationFrame(() => $("#bob-repository").focus());
    return;
  }
  loadVerifiedCase(source);
}

function initialize() {
  $("#bob-analyze-form").addEventListener("submit", analyzeRepositoryWithBob);
  $("#case-selector").addEventListener("change", (event) => chooseAnalysisSource(event.target.value));
  $("#tab-queue").addEventListener("click", () => switchView("queue"));
  $("#tab-graph").addEventListener("click", () => switchView("graph"));
  $("#overlay").addEventListener("click", (event) => { if (event.target === $("#overlay")) closeFindingModal(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && $("#overlay").classList.contains("open")) closeFindingModal(); });
  $("#pr-search").addEventListener("input", (event) => {
    const query = event.target.value.replace(/^#/, "").trim();
    if (!query) { $("#search-note").textContent = ""; return; }
    const pr = state.model?.prs.find((item) => String(item.num) === query);
    $("#search-note").textContent = pr ? "" : "Not found";
    if (pr) select("pr", pr.id);
  });
  loadVerifiedCase("zeppelin");
}

initialize();
