import { adaptBackendResponse, parseRepositoryInput } from "./demo-data.js";

const $ = (selector) => document.querySelector(selector);
const state = { model: null, filter: "needs-action", graphFilter: "all", selected: null, view: "queue", loading: false, progressTimer: null, progressStartedAt: 0 };
const verdicts = {
  conflict: { label: "Confirmed conflict", color: "#D6453A", badge: "silent" },
  coordination: { label: "Merge coordination", color: "#7A4FD6", badge: "gittoo" },
  review: { label: "Needs review", color: "#DC9B00", badge: "stale" },
};

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

async function request(path, payload = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Backend request failed (${response.status})`);
  return data;
}

function setStatus(message, tone = "") {
  const element = $("#clone-status");
  element.className = `clone-status ${tone}`;
  element.textContent = message;
}

function setLoading(active) {
  state.loading = active;
  $("#clone-btn").disabled = active;
  $("#clone-btn").textContent = active ? "Analyzing…" : "Analyze repo";
}

function progressSnapshot(elapsedSeconds) {
  if (elapsedSeconds < 4) return { value: 8 + elapsedSeconds * 3, stage: "Fetching open pull requests" };
  if (elapsedSeconds < 12) return { value: 20 + (elapsedSeconds - 4) * 2.5, stage: "Downloading PR diffs" };
  if (elapsedSeconds < 28) return { value: 40 + (elapsedSeconds - 12) * 1.25, stage: "Building candidate pairs" };
  if (elapsedSeconds < 55) return { value: 60 + (elapsedSeconds - 28) * .67, stage: "Checking semantic relationships" };
  if (elapsedSeconds < 90) return { value: 78 + (elapsedSeconds - 55) * .29, stage: "Running merge preflight and AI judgment" };
  return { value: Math.min(94, 88 + Math.log2(1 + elapsedSeconds - 90)), stage: "Finalizing evidence and relationships" };
}

function updateProgress(value, stage) {
  const rounded = Math.max(0, Math.min(100, Math.round(value)));
  $("#progress-fill").style.width = `${rounded}%`;
  $("#progress-percent").textContent = `${rounded}%`;
  $("#progress-stage").textContent = stage;
  $("#progress-track").setAttribute("aria-valuenow", String(rounded));
}

function startProgress() {
  window.clearInterval(state.progressTimer);
  state.progressStartedAt = Date.now();
  const panel = $("#analysis-progress");
  panel.hidden = false;
  panel.className = "analysis-progress";
  updateProgress(5, "Connecting to GitHub");
  state.progressTimer = window.setInterval(() => {
    const elapsed = (Date.now() - state.progressStartedAt) / 1000;
    const snapshot = progressSnapshot(elapsed);
    updateProgress(snapshot.value, snapshot.stage);
  }, 350);
}

function finishProgress(success, message) {
  window.clearInterval(state.progressTimer);
  state.progressTimer = null;
  const panel = $("#analysis-progress");
  panel.classList.add(success ? "done" : "failed");
  updateProgress(success ? 100 : Number($("#progress-track").getAttribute("aria-valuenow")), message);
  window.setTimeout(() => { panel.hidden = true; }, success ? 850 : 2400);
}

function prById(id) {
  return state.model?.prs.find((pr) => pr.id === id);
}

function findingById(id) {
  return state.model?.findings.find((finding) => finding.id === id);
}

function renderFunnel() {
  const { summary } = state.model;
  const actionable = summary.conflictCount + summary.coordinationCount + summary.reviewCount;
  const steps = [
    [summary.prCount, "Open PRs"],
    [summary.pairCount, "Possible pairs"],
    [summary.candidateCount, "Backend candidates"],
    [summary.aiReviewedPairCount, "AI reviewed"],
    [actionable, "Needs attention"],
  ];
  $("#funnel").innerHTML = steps.map(([number, label], index) => `
    <div class="fstep real ${index === steps.length - 1 ? "final" : ""}">
      <span class="tag">BACKEND</span><span class="num">${escapeHtml(number)}</span><span class="lbl">${escapeHtml(label)}</span>
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
  const conflicts = state.model.findings.filter((item) => item.verdict === "conflict");
  const reviews = state.model.findings.filter((item) => item.verdict === "review");
  const coordination = state.model.findings.filter((item) => item.verdict === "coordination");
  const primary = conflicts[0] || reviews[0] || coordination[0];
  const flaggedPrIds = new Set(state.model.findings.flatMap((finding) => finding.prIds));
  const noActionPrCount = Math.max(0, state.model.summary.prCount - flaggedPrIds.size);
  const context = `<details class="plan"><summary>Analysis coverage <span class="n">backend result · ${escapeHtml(state.model.mode)}</span></summary>
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
    const executionLabel = runCount ? `${runCount} Base/A/B/A+B result(s) available` : "Executable verification not run";
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
        <div class="hero-actions"><button class="primary" data-open-finding="${escapeHtml(primary.id)}">View code evidence</button><button data-open-finding="${escapeHtml(primary.id)}">View A/B/A+B status</button><span class="verify-state">${escapeHtml(executionLabel)}</span></div>
      </div>
    </article>`;
  }
  const reviewRows = reviews.length
    ? `<div class="compact-list">${reviews.slice(0, 6).map(compactRow).join("")}${reviews.length > 6 ? `<details class="more-results"><summary>Show ${reviews.length - 6} more review pair(s)</summary>${reviews.slice(6).map(compactRow).join("")}</details>` : ""}</div>`
    : `<div class="qempty">No additional review pair was returned.</div>`;
  const coordinationSection = coordination.length ? `<section class="action-section"><div class="section-hd"><h3>Merge coordination</h3><span>${coordination.length} mechanical or workflow pair(s)</span></div><div class="compact-list">${coordination.map(compactRow).join("")}</div></section>` : "";
  $("#queue-wrap").innerHTML = `
    <section class="scan-overview">
      <div class="scan-title"><h2>Scan result</h2><p>${escapeHtml(state.model.summary.prCount)} open PRs · ${escapeHtml(state.model.summary.pairCount)} possible pairs analyzed</p></div>
      <div class="scan-kpis">
        <div class="scan-kpi danger"><div class="klabel"><span class="vdot" style="background:${verdicts.conflict.color}"></span>Confirmed conflict</div><div class="knum">${conflicts.length}<span class="kunit">pair(s)</span></div></div>
        <div class="scan-kpi warning"><div class="klabel"><span class="vdot" style="background:${verdicts.review.color}"></span>Needs review</div><div class="knum">${reviews.length}<span class="kunit">pair(s)</span></div></div>
        <div class="scan-kpi"><div class="klabel"><span class="vdot" style="background:#AAB4BC"></span>No action found</div><div class="knum">${noActionPrCount}<span class="kunit">PR(s)</span></div></div>
      </div>
    </section>
    ${hero}
    <section class="action-section"><div class="section-hd"><h3>Needs review</h3><span>${reviews.length} pair(s) requiring human judgment</span></div>${reviewRows}</section>
    ${coordinationSection}
    <div class="map-strip"><div class="map-copy"><b>Repository relationship map</b>See all ${escapeHtml(state.model.summary.prCount)} PRs while confirmed conflicts and review candidates stay highlighted.</div><button class="map-cta" data-switch-graph>View full repository map →</button></div>
    ${context}`;
  $("#queue-wrap").querySelectorAll("[data-finding]").forEach((row) => row.addEventListener("click", () => select("finding", row.dataset.finding)));
  $("#queue-wrap").querySelectorAll("[data-open-finding]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    select("finding", button.dataset.openFinding);
  }));
  $("#queue-wrap").querySelector("[data-switch-graph]")?.addEventListener("click", () => switchView("graph"));
}

function renderEmptyDetail() {
  $("#side-hd").innerHTML = `<span class="title">Backend analysis</span><span class="mono">${escapeHtml(state.model.repository)}</span>`;
  $("#side-body").innerHTML = `<div class="empty">Select a queue item, PR node, or resource to inspect the backend's evidence.<br><br>No frontend-only score or verdict is added here.</div>`;
}

function runTable(runs) {
  if (!runs?.length) return `<div class="callout"><b>Executable verification not run.</b><br>This relationship is currently based on ${escapeHtml(state.model.mode)} analysis.</div>`;
  return `<div class="lane"><div class="lane-hd"><span class="fn">Base / A / B / A+B</span></div><div class="lane-body">${runs.map((run) => `<div><b>${escapeHtml(String(run.label || "run").toUpperCase())}</b> — ${escapeHtml(run.status || run.result || "unknown")}</div>`).join("")}</div></div>`;
}

function renderFindingDetail(finding) {
  const a = prById(finding.prIds[0]);
  const b = prById(finding.prIds[1]);
  const verdict = verdicts[finding.verdict];
  const coordinationNote = finding.verdict === "coordination"
    ? `<div class="callout"><b>Why this is not a confirmed semantic conflict</b><br>This pair needs merge-order, rebase, text-conflict resolution, or duplicate-work consolidation. Git or repository history already exposes the coordination need; the backend has not confirmed a silent pair-induced regression.</div>`
    : "";
  $("#side-hd").innerHTML = `<span class="vdot" style="background:${verdict.color}"></span><span class="title">${escapeHtml(verdict.label)}</span><button class="xbtn" aria-label="Close">×</button>`;
  $("#side-body").innerHTML = `
    <div class="kv"><b><a href="${escapeHtml(a.url || "#")}" target="_blank" rel="noreferrer">#${escapeHtml(a.num)}</a> × <a href="${escapeHtml(b.url || "#")}" target="_blank" rel="noreferrer">#${escapeHtml(b.num)}</a></b><br>${escapeHtml(finding.title)}<br><span class="chip">${escapeHtml(finding.categoryLabel)}</span><span class="chip">${escapeHtml(finding.basis)}</span><span class="chip">${escapeHtml(finding.source)}</span></div>
    ${coordinationNote}
    <div class="sec-title">Backend summary</div><div class="callout blue">${escapeHtml(finding.summary)}</div>
    <div class="sec-title">Hidden assumptions</div>
    <div class="assump" style="border-left-color:${verdict.color}"><span class="atype">PR #${escapeHtml(a.num)}</span>${escapeHtml(finding.assumptionA)}</div>
    <div class="assump" style="border-left-color:${verdict.color}"><span class="atype">PR #${escapeHtml(b.num)}</span>${escapeHtml(finding.assumptionB)}</div>
    <div class="sec-title">If merged together</div><div class="callout red">${escapeHtml(finding.consequence)}</div>
    <div class="sec-title">Recommended action</div><div class="callout blue">${escapeHtml(finding.recommendation)}</div>
    <div class="sec-title">Execution evidence</div>${runTable(finding.verification.runs)}
    <div class="sec-title">Code evidence</div>${finding.evidence.length ? finding.evidence.map((item, index) => `<div class="lane"><div class="lane-hd"><span class="fn">E${index + 1}</span></div><div class="lane-body">${escapeHtml(item)}</div></div>`).join("") : `<div class="empty">No evidence text was returned.</div>`}
    ${finding.witnesses.length ? `<div class="sec-title">Analyzer witnesses</div>${finding.witnesses.map((item) => `<div class="lane"><div class="lane-hd"><span class="fn">${escapeHtml(item.title)}</span>${item.strength == null ? "" : `<span class="cnt">${escapeHtml(item.strength)}</span>`}</div><div class="lane-body">${escapeHtml(item.explanation)}</div></div>`).join("")}` : ""}`;
  $("#side-hd .xbtn").addEventListener("click", () => select("none"));
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

function renderLegend() {
  $("#legend").innerHTML = `<div class="row"><b>Priority</b></div>` + Object.entries(verdicts).map(([, item]) => `<div class="row"><span class="vdot" style="background:${item.color}"></span>${item.label}</div>`).join("") + `<div class="row"><span class="vdot" style="background:#AAB4BC"></span>No action found</div><div class="row">○ PR &nbsp; □ shared file / contract</div>`;
}

function graphFindings() {
  if (state.graphFilter === "all") return state.model.findings;
  if (state.graphFilter === "attention") return state.model.findings.filter((finding) => finding.verdict === "conflict" || finding.verdict === "review");
  return state.model.findings.filter((finding) => finding.verdict === state.graphFilter);
}

function renderGraphPriority() {
  const counts = Object.fromEntries(Object.keys(verdicts).map((key) => [key, state.model.findings.filter((item) => item.verdict === key).length]));
  const hidden = Math.max(0, state.model.prs.length - new Set(graphFindings().flatMap((finding) => finding.prIds)).size);
  const button = (filter, title, count, color, extra = "") => `<button class="graph-focus ${extra} ${state.graphFilter === filter ? "active" : ""}" data-graph-filter="${filter}" ${filter === "coordination" ? 'title="Text conflicts, stacked PRs, or duplicate work that need merge-order, rebase, or consolidation—not a confirmed silent semantic conflict."' : ""}><span class="gf-top"><span class="vdot" style="background:${color}"></span>${title}</span><span class="gf-count">${count}</span></button>`;
  $("#graph-priority").innerHTML = [
    button("conflict", "Confirmed", counts.conflict, verdicts.conflict.color),
    button("review", "Needs review", counts.review, verdicts.review.color),
    button("attention", "Priority only", counts.conflict + counts.review, "#fff", "start"),
    button("all", "All PRs", state.model.prs.length, "#0F62FE"),
    button("coordination", "Merge coordination", counts.coordination, verdicts.coordination.color),
    state.graphFilter === "all" ? "" : `<span class="graph-hidden-note">${hidden} unrelated PR(s) hidden</span>`,
  ].join("");
  $("#graph-priority").querySelectorAll("[data-graph-filter]").forEach((control) => control.addEventListener("click", () => {
    state.graphFilter = control.dataset.graphFilter;
    renderGraph();
  }));
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
  const coordinationPrIds = new Set(state.model.findings.filter((finding) => finding.verdict === "coordination").flatMap((finding) => finding.prIds));
  const priorityResourcePaths = new Set(priorityFindings.flatMap((finding) => finding.resources));
  const focusPrIds = new Set(findings.flatMap((finding) => finding.prIds));
  const findingResourcePaths = new Set(findings.flatMap((finding) => finding.resources));
  const prs = state.graphFilter === "all" ? state.model.prs : state.model.prs.filter((pr) => focusPrIds.has(pr.id));
  const visiblePrIds = new Set(prs.map((pr) => pr.id));
  const resources = state.model.resources.filter((resource) => {
    const visibleUsers = resource.prIds.filter((id) => visiblePrIds.has(id)).length;
    return visibleUsers > 1 && (state.graphFilter === "all" || findingResourcePaths.has(resource.path));
  }).slice(0, state.graphFilter === "all" ? 40 : 24);
  const nodes = [
    ...prs.map((pr) => ({ ...pr, kind: "pr", priority: priorityPrIds.has(pr.id), coordination: coordinationPrIds.has(pr.id) })),
    ...resources.map((resource) => ({ ...resource, kind: "resource", priority: priorityResourcePaths.has(resource.path), coordination: false })),
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
  renderLegend();
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
  nodes.forEach((item) => {
    if (!isAll || item.priority) return;
    item.x = 48 + stableUnit(item.id, 17) * Math.max(1, width - 96);
    item.y = 118 + stableUnit(item.id, 71) * Math.max(1, height - 176);
  });
  const simulation = window.d3.forceSimulation(nodes)
    .force("link", window.d3.forceLink(links).id((item) => item.id).distance((link) => link.kind === "finding" ? (link.finding.verdict === "conflict" ? 135 : 165) : 70).strength((link) => link.kind === "finding" ? .52 : .22))
    .force("charge", window.d3.forceManyBody().strength((item) => isAll ? (item.priority ? -230 : -42) : -270))
    .force("center", window.d3.forceCenter(width / 2, height / 2))
    .force("priority-x", window.d3.forceX((item) => item.priority ? width * .5 : item.x).strength((item) => isAll ? (item.priority ? .24 : .018) : .08))
    .force("priority-y", window.d3.forceY((item) => item.priority ? height * .48 : item.y).strength((item) => isAll ? (item.priority ? .24 : .018) : .08))
    .force("collision", window.d3.forceCollide().radius((item) => item.kind === "pr" ? (item.priority ? 50 : item.coordination ? 31 : 18) : (item.priority ? 28 : 15)));
  const viewport = svg.append("g");
  svg.call(window.d3.zoom().scaleExtent([.4, 3]).on("zoom", (event) => viewport.attr("transform", event.transform)));
  const link = viewport.append("g").selectAll("line").data(links).join("line")
    .attr("stroke", (item) => item.kind === "finding" ? verdicts[item.finding.verdict].color : "#C8D0D5")
    .attr("stroke-width", (item) => item.kind === "finding" ? (item.finding.verdict === "conflict" ? 5 : 3.5) : 1)
    .attr("stroke-dasharray", (item) => item.kind === "resource" ? "3 4" : null)
    .attr("opacity", (item) => item.kind === "finding" ? (item.finding.verdict === "conflict" || item.finding.verdict === "review" ? .96 : .5) : (isAll ? .18 : .5))
    .style("cursor", (item) => item.kind === "finding" ? "pointer" : "default")
    .on("click", (_, item) => { if (item.kind === "finding") select("finding", item.finding.id); });
  link.filter((item) => item.kind === "finding").append("title").text((item) => `${verdicts[item.finding.verdict].label}: ${item.finding.title}`);
  const groups = viewport.append("g").selectAll("g").data(nodes).join("g").attr("class", (item) => `node ${item.priority ? "priority-node" : "context-node"}`)
    .call(window.d3.drag().on("start", (event, item) => { if (!event.active) simulation.alphaTarget(.3).restart(); item.fx = item.x; item.fy = item.y; })
      .on("drag", (event, item) => { item.fx = event.x; item.fy = event.y; })
      .on("end", (event, item) => { if (!event.active) simulation.alphaTarget(0); item.fx = null; item.fy = null; }));
  const prVerdict = (prId) => findings.find((finding) => finding.prIds.includes(prId) && finding.verdict === "conflict")?.verdict
    || findings.find((finding) => finding.prIds.includes(prId) && finding.verdict === "review")?.verdict
    || findings.find((finding) => finding.prIds.includes(prId) && finding.verdict === "coordination")?.verdict;
  groups.filter((item) => item.kind === "pr" && item.priority).append("circle")
    .attr("r", 31).attr("fill", "none").attr("stroke", (item) => verdicts[prVerdict(item.id)]?.color || "#0F62FE").attr("stroke-width", 6).attr("opacity", .18);
  groups.filter((item) => item.kind === "pr").append("circle")
    .attr("r", (item) => prVerdict(item.id) === "conflict" ? 24 : prVerdict(item.id) === "review" ? 21 : prVerdict(item.id) === "coordination" ? 14 : 9)
    .attr("fill", (item) => verdicts[prVerdict(item.id)]?.color || "#AAB4BC")
    .attr("stroke", "#fff").attr("stroke-width", (item) => item.priority ? 3 : 2).attr("opacity", (item) => item.priority ? 1 : item.coordination ? .85 : .62);
  groups.filter((item) => item.kind === "resource").append("rect").attr("x", (item) => -Math.min(16, 7 + item.total * 2)).attr("y", (item) => -Math.min(16, 7 + item.total * 2)).attr("width", (item) => Math.min(32, 14 + item.total * 4)).attr("height", (item) => Math.min(32, 14 + item.total * 4)).attr("rx", 3).attr("fill", "#fff").attr("stroke", (item) => item.priority ? "#5C6B78" : "#AAB4BC").attr("opacity", (item) => item.priority ? 1 : .42);
  groups.append("text").attr("class", (item) => item.kind === "pr" ? "pr-label" : "res-label").attr("x", (item) => item.priority ? 31 : 16).attr("y", 4).attr("font-size", (item) => item.priority ? 12 : 10).attr("font-weight", (item) => item.priority ? 700 : item.kind === "pr" ? 500 : 400).attr("fill", (item) => item.priority ? "#17242B" : "#7A8790").attr("opacity", (item) => item.priority ? 1 : .58).text((item) => item.kind === "pr" ? `#${item.num} ${item.title.length > 22 ? `${item.title.slice(0, 21)}…` : item.title}` : item.path.length > 32 ? `…${item.path.slice(-31)}` : item.path);
  groups.append("title").text((item) => item.kind === "pr" ? `PR #${item.num}: ${item.title}` : item.path);
  groups.on("click", (_, item) => select(item.kind, item.id));
  simulation.on("tick", () => {
    link.attr("x1", (item) => item.source.x).attr("y1", (item) => item.source.y).attr("x2", (item) => item.target.x).attr("y2", (item) => item.target.y);
    groups.attr("transform", (item) => `translate(${item.x},${item.y})`);
  });
  $("#graph-hint").textContent = findings.length
    ? state.graphFilter === "all"
      ? `All ${state.model.prs.length} PRs are shown. Confirmed conflicts and review candidates are enlarged and pulled to the center; muted nodes remain as repository context.`
      : `${findings.length} prioritized relationship(s) shown. Conflict is highest priority; merge coordination is mechanical/operational follow-up.`
    : "No relationship in this filter. Choose another category or All context.";
}

function switchView(view) {
  state.view = view;
  $("#queue-wrap").style.display = view === "queue" ? "block" : "none";
  $("#graph-wrap").style.display = view === "graph" ? "block" : "none";
  $("#tab-queue").classList.toggle("active", view === "queue");
  $("#tab-graph").classList.toggle("active", view === "graph");
  if (view === "graph") requestAnimationFrame(renderGraph);
}

function renderModel(model) {
  state.model = model;
  state.selected = null;
  state.graphFilter = "all";
  $("#repo-label").textContent = model.repository;
  $("#engine-note").innerHTML = `<b>Live backend</b> — ${escapeHtml(model.mode)} · generated ${escapeHtml(new Date(model.generatedAt).toLocaleString())}`;
  $("#store-note").textContent = `${model.findings.length} backend finding(s)`;
  renderFunnel();
  renderQueue();
  renderEmptyDetail();
  if (state.view === "graph") renderGraph();
  try { sessionStorage.setItem("mergescope-live-result-v1", JSON.stringify(model)); } catch {}
}

async function loadRepository() {
  if (state.loading) return;
  try {
    const repository = parseRepositoryInput($("#clone-input").value);
    setLoading(true);
    setStatus("");
    startProgress();
    const data = await request("/api/analyze", {
      repository,
      limit: 100,
      useAI: true,
      useMergePreflight: true,
      useVerification: false,
    });
    const model = adaptBackendResponse(data);
    finishProgress(true, "Analysis complete");
    renderModel(model);
    setStatus(`${repository}: ${model.summary.prCount} PRs, ${model.summary.pairCount} pairs, ${model.findings.length} actionable finding(s).`, "ok");
  } catch (error) {
    finishProgress(false, "Analysis stopped");
    setStatus(error.message, "err");
  } finally {
    setLoading(false);
  }
}

async function initialize() {
  $("#clone-btn").addEventListener("click", loadRepository);
  $("#clone-input").addEventListener("keydown", (event) => { if (event.key === "Enter") loadRepository(); });
  $("#tab-queue").addEventListener("click", () => switchView("queue"));
  $("#tab-graph").addEventListener("click", () => switchView("graph"));
  $("#pr-search").addEventListener("input", (event) => {
    const query = event.target.value.replace(/^#/, "").trim();
    if (!query) { $("#search-note").textContent = ""; return; }
    const pr = state.model?.prs.find((item) => String(item.num) === query);
    $("#search-note").textContent = pr ? "" : "Not found";
    if (pr) select("pr", pr.id);
  });
  try {
    const response = await fetch("/api/status");
    const status = await response.json();
    $("#budget-n").textContent = status.aiConfigured
      ? `${status.aiProvider} / ${status.model}${status.reasoningEffort ? ` / ${status.reasoningEffort}` : ""}`
      : "heuristic only — AI not configured";
    $("#engine-note").innerHTML = `<b>${status.aiConfigured ? "AI backend ready" : "Heuristic-only mode"}</b> — GitHub ${status.githubConfigured ? "authenticated" : "public rate limit"} · merge-tree ${status.mergeTreePreflight ? "on" : "off"}`;
  } catch {
    $("#budget-n").textContent = "backend unavailable";
  }
  try {
    const cached = JSON.parse(sessionStorage.getItem("mergescope-live-result-v1") || "null");
    if (cached?.prs && cached?.findings) {
      renderModel(cached);
      setStatus("Restored the most recent backend result from this browser session.", "ok");
      return;
    }
  } catch {}
  try {
    setLoading(true);
    setStatus("Loading a synthetic sample through the real backend…", "warn");
    const model = adaptBackendResponse(await request("/api/demo", { useAI: false }));
    renderModel(model);
    setStatus("Backend sample loaded. Enter a GitHub repository to run a live scan.", "ok");
  } catch (error) {
    setStatus(`Backend sample failed: ${error.message}`, "err");
  } finally {
    setLoading(false);
  }
}

initialize();
