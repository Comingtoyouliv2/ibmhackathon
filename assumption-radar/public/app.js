const $ = (selector) => document.querySelector(selector);
const state = { data: null, selected: null, filter: "all", loadingTimer: null };
const verdictColor = { conflict: "#ff5c35", coordination: "#a98bff", review: "#ffbd2e" };

function findingLabel(finding) {
  if (finding.verdict === "conflict" && finding.confirmationStatus === "executable-confirmed") return "execution confirmed";
  if (finding.verdict === "conflict" && finding.confirmationStatus === "contract-backed-static") return "contract-backed conflict";
  if (finding.verdict === "conflict") return "static conflict candidate";
  if (finding.verdict === "coordination") return "merge coordination";
  if (finding.verdict === "review") return "semantic review";
  return finding.verdict;
}

function findingBadge(finding) {
  if (finding.verdict === "conflict" && finding.confirmationStatus === "executable-confirmed") return "PROVEN";
  if (finding.verdict === "conflict" && finding.confirmationStatus === "contract-backed-static") return "CONTRACT";
  if (finding.verdict === "conflict") return "CANDIDATE";
  return finding.verdict === "coordination" ? "COORD" : "REVIEW";
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.add("hidden"), 5200);
}

function setLoading(active) {
  const loading = $("#loading");
  loading.classList.toggle("hidden", !active);
  window.clearInterval(state.loadingTimer);
  if (!active) return;
  const messages = [
    "Extracting contract signals from the diffs…",
    "Connecting shared data and API boundaries…",
    "Comparing the assumptions made by each PR…",
    "Verifying selected PR pairs in an isolated environment…",
    "Keeping only conflicts supported by explainable evidence…",
  ];
  let index = 0;
  $("#loadingText").textContent = messages[index];
  state.loadingTimer = window.setInterval(() => {
    index = (index + 1) % messages.length;
    $("#loadingText").textContent = messages[index];
  }, 1700);
}

async function api(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function metric(label, value, className = "") {
  return `<div class="metric ${className}"><span class="label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderMetrics(summary) {
  const verification = summary.verifiedPairCount
    ? `${summary.confirmedConflictCount} CONFIRMED / ${summary.verifiedCompatibleCount} NOT REPRODUCED`
    : "NOT RUN";
  $("#metrics").innerHTML = [
    metric("OPEN PULL REQUESTS", summary.prCount),
    metric("PAIRS EXAMINED", summary.pairCount),
    metric("PAIR EXECUTION", verification),
    metric("MERGE VERDICT", summary.verdict, "verdict"),
  ].join("");
}

function prById(id) {
  return state.data.prs.find((pr) => pr.id === id);
}

function svgEl(name, attrs = {}, text = "") {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
  if (text) element.textContent = text;
  return element;
}

function renderRadar() {
  const svg = $("#radar");
  svg.replaceChildren();
  const defs = svgEl("defs");
  const gradient = svgEl("linearGradient", { id: "sweep", x1: "0", x2: "1", y1: "1", y2: "0" });
  gradient.append(svgEl("stop", { offset: "0", "stop-color": "#c8ff3d", "stop-opacity": "0" }), svgEl("stop", { offset: "1", "stop-color": "#c8ff3d", "stop-opacity": ".8" }));
  defs.append(gradient);
  svg.append(defs);
  const cx = 360;
  const cy = 305;
  [82, 150, 220, 280].forEach((r) => svg.append(svgEl("circle", { cx, cy, r, class: "radar-ring" })));
  for (let i = 0; i < 12; i += 1) {
    const angle = i * Math.PI / 6;
    svg.append(svgEl("line", { x1: cx, y1: cy, x2: cx + Math.cos(angle) * 280, y2: cy + Math.sin(angle) * 280, class: "radar-axis" }));
  }
  svg.append(svgEl("path", { d: `M ${cx} ${cy} L ${cx + 275} ${cy} A 275 275 0 0 1 ${cx + 194} ${cy + 194} Z`, class: "radar-sweep" }));

  const count = state.data.prs.length;
  const positions = new Map();
  state.data.prs.forEach((pr, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(count, 1);
    const radius = index % 2 ? 220 : 265;
    positions.set(pr.id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, angle });
  });

  const lines = svgEl("g", { class: "conflict-lines" });
  state.data.findings.forEach((conflict) => {
    const a = positions.get(conflict.prIds[0]);
    const b = positions.get(conflict.prIds[1]);
    if (!a || !b) return;
    const line = svgEl("line", {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: verdictColor[conflict.verdict],
      "stroke-width": conflict.verdict === "conflict" ? 4 : 3,
      opacity: conflict.verdict === "review" ? .62 : .85,
      class: `conflict-line ${state.selected === conflict.id ? "active" : ""}`,
      "data-id": conflict.id,
    });
    line.addEventListener("click", () => selectConflict(conflict.id));
    lines.append(line);
  });
  svg.append(lines);

  const center = svgEl("g");
  center.append(svgEl("circle", { cx, cy, r: 48, class: "radar-center" }));
  center.append(svgEl("text", { x: cx, y: cy - 5, class: "radar-center-label" }, "MAIN"));
  center.append(svgEl("text", { x: cx, y: cy + 12, class: "radar-center-label" }, `${state.data.prs.length} OPEN`));
  svg.append(center);

  state.data.prs.forEach((pr) => {
    const pos = positions.get(pr.id);
    const group = svgEl("g", { class: "pr-node", transform: `translate(${pos.x} ${pos.y})`, tabindex: "0", role: "button", "aria-label": `PR ${pr.number} ${pr.title}` });
    group.append(svgEl("circle", { r: 24, class: "node-pulse" }));
    group.append(svgEl("circle", { r: 20 }));
    group.append(svgEl("text", { x: 0, y: 0 }, `#${pr.number}`));
    const anchor = Math.cos(pos.angle) > .2 ? "start" : Math.cos(pos.angle) < -.2 ? "end" : "middle";
    const labelX = anchor === "start" ? 30 : anchor === "end" ? -30 : 0;
    const labelY = Math.sin(pos.angle) > .5 ? 40 : Math.sin(pos.angle) < -.5 ? -34 : 4;
    group.append(svgEl("text", { x: labelX, y: labelY, class: "pr-label", "text-anchor": anchor }, pr.title.length > 19 ? `${pr.title.slice(0, 18)}…` : pr.title));
    const onSelect = () => {
      const first = state.data.findings.find((item) => item.prIds.includes(pr.id));
      if (first) selectConflict(first.id);
      else showToast(`No assumption conflict was found for PR #${pr.number}.`);
    };
    group.addEventListener("click", onSelect);
    group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") onSelect(); });
    svg.append(group);
  });
}

function renderDetail(conflict) {
  const a = prById(conflict.prIds[0]);
  const b = prById(conflict.prIds[1]);
  const runs = conflict.verification?.runs || [];
  const execution = runs.length ? `<div class="detail-block"><b>BASE / A / B / A+B</b><div class="evidence-list">${runs
    .filter((run) => run.label !== "combined_confirmation")
    .map((run) => `<span>${escapeHtml(run.label.toUpperCase())}: ${escapeHtml(run.status)}</span>`).join("")}</div></div>` : "";
  $("#detailCard").innerHTML = `
    <div class="detail-content">
      <div class="detail-top">
        <span class="severity ${escapeHtml(conflict.verdict)}">${escapeHtml(findingLabel(conflict))}</span>
        <span class="confidence">${conflict.source === "ai" ? "AI JUDGMENT" : escapeHtml(conflict.basis.toUpperCase())}</span>
      </div>
      <h3>${escapeHtml(conflict.title)}</h3>
      <p class="detail-summary">${escapeHtml(conflict.summary)}</p>
      <div class="assumption-pair">
        <div class="assumption"><span class="pr-tag">#${a.number} · ${escapeHtml(a.author)}</span><p>${escapeHtml(conflict.assumptionA)}</p></div>
        <div class="collision-mark">× HIDDEN ASSUMPTION ×</div>
        <div class="assumption"><span class="pr-tag">#${b.number} · ${escapeHtml(b.author)}</span><p>${escapeHtml(conflict.assumptionB)}</p></div>
      </div>
      <div class="detail-block"><b>IF MERGED TOGETHER</b><p>${escapeHtml(conflict.consequence)}</p></div>
      <div class="detail-block"><b>SAFEST NEXT MOVE</b><p>${escapeHtml(conflict.recommendation)}</p></div>
      ${execution}
      <div class="detail-block"><b>EVIDENCE</b><div class="evidence-list">${conflict.evidence.map((item) => `<span>${escapeHtml(item)}</span>`).join("") || "<span>diff context</span>"}</div></div>
    </div>`;
}

function filteredConflicts() {
  if (state.filter === "all") return state.data.findings;
  return state.data.findings.filter((item) => item.verdict === state.filter || item.category === state.filter);
}

function renderFilters() {
  const options = [["all", "All"], ["conflict", "Conflict"], ["coordination", "Merge coordination"], ["review", "Needs review"], ["event", "Events"], ["data", "Data"]];
  $("#filters").innerHTML = options.map(([value, label]) => `<button class="filter ${state.filter === value ? "active" : ""}" data-filter="${value}">${label}</button>`).join("");
  $("#filters").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    renderFilters();
    renderConflictList();
  }));
}

function renderConflictList() {
  const list = $("#conflictList");
  const conflicts = filteredConflicts();
  if (!conflicts.length) {
    list.innerHTML = `<div class="empty-state">No conflict signals match this filter.</div>`;
    return;
  }
  list.innerHTML = conflicts.map((conflict) => {
    const a = prById(conflict.prIds[0]);
    const b = prById(conflict.prIds[1]);
    return `<article class="conflict-row ${state.selected === conflict.id ? "active" : ""}" data-id="${escapeHtml(conflict.id)}">
      <div class="risk-score"><span>${escapeHtml(findingBadge(conflict))}</span><small>EVIDENCE</small></div>
      <div class="pair-label"><b>#${a.number}</b> × <b>#${b.number}</b></div>
      <div class="conflict-main"><h3>${escapeHtml(conflict.title)}</h3><p>${escapeHtml(conflict.summary)}</p></div>
      <div class="category-label">${escapeHtml(state.data.categories[conflict.category] || conflict.category)} · ${escapeHtml(conflict.basis.replaceAll("-", " ").toUpperCase())}</div>
      <div class="row-arrow">↗</div>
    </article>`;
  }).join("");
  list.querySelectorAll(".conflict-row").forEach((row) => row.addEventListener("click", () => selectConflict(row.dataset.id)));
}

function selectConflict(id) {
  const conflict = state.data.findings.find((item) => item.id === id);
  if (!conflict) return;
  state.selected = id;
  renderRadar();
  renderConflictList();
  renderDetail(conflict);
  if (window.innerWidth < 951) $("#detailCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function render(data, title) {
  state.data = data;
  state.selected = data.findings[0]?.id || null;
  state.filter = "all";
  $("#workspace").classList.remove("hidden");
  $("#workspaceTitle").textContent = title || data.repository || "Sample repository conflict map";
  $("#lastScan").textContent = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", month: "short", day: "2-digit" }).format(new Date(data.generatedAt));
  $("#systemMode").textContent = data.mode === "ai+heuristic" ? "AI + SIGNAL ENGINE ACTIVE" : "SIGNAL ENGINE ACTIVE";
  renderMetrics(data.summary);
  renderFilters();
  renderConflictList();
  renderRadar();
  if (data.findings[0]) renderDetail(data.findings[0]);
  else $("#detailCard").innerHTML = `<div class="empty-detail"><span class="crosshair">✓</span><h3>No conflict signals</h3><p>No cross-PR assumption conflict was found in the current diff evidence. Continue running integration tests.</p></div>`;
  if (data.aiError) showToast(`AI analysis failed, so rule-based results are shown: ${data.aiError}`);
  if (data.verificationError) showToast(`Combined execution could not be completed: ${data.verificationError}`);
  $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("#repoForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const repository = $("#repository").value.trim();
  if (!repository) return showToast("Enter a GitHub repository to analyze.");
  setLoading(true);
  try {
    const data = await api("/api/analyze", {
      repository,
      useAI: $("#useAI").checked,
      useVerification: $("#useVerification").checked,
      verificationLimit: 3,
    });
    render(data, data.repository);
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(false);
  }
});

$("#demoButton").addEventListener("click", async () => {
  setLoading(true);
  try {
    const data = await api("/api/demo", { useAI: $("#useAI").checked });
    render(data, "acme/commerce · demo");
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(false);
  }
});

fetch("/api/status").then((response) => response.json()).then((status) => {
  const parts = [status.githubConfigured ? "GitHub token connected" : "Public repository mode"];
  parts.push(status.openaiConfigured ? `${status.model} connected` : "No AI key — using signal engine");
  if (status.mergeTreePreflight) parts.push("merge-tree preflight");
  if (status.combinedVerification) parts.push("A/B/A+B verifier");
  $("#configHint").textContent = parts.join(" · ");
}).catch(() => { $("#configHint").textContent = "Local engine"; });
