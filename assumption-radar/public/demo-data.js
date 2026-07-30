const VERDICT_ORDER = { conflict: 0, coordination: 1, review: 2 };

export function parseRepositoryInput(value = "") {
  let input = String(value).trim();
  if (!input) throw new Error("Enter a GitHub repository URL.");
  input = input.replace(/^git\s+clone\s+/i, "").replace(/\s+.*$/, "");
  if (/^https?:\/\//i.test(input) && !/^https?:\/\/github\.com\//i.test(input)) {
    throw new Error("The live demo currently supports GitHub repositories only.");
  }
  if (/^git@/i.test(input) && !/^git@github\.com:/i.test(input)) {
    throw new Error("The live demo currently supports GitHub repositories only.");
  }
  input = input.replace(/^git@github\.com:/i, "").replace(/^https?:\/\/github\.com\//i, "");
  input = input.replace(/\.git\/?$/, "").replace(/^\/+|\/+$/g, "");
  const parts = input.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("Use owner/repo or a GitHub URL.");
  return `${parts[0]}/${parts[1]}`;
}

function normalizeAssumptions(pr = {}) {
  const raw = pr.assumptions || pr.changeModel?.assumptions || [];
  return raw.map((item) => typeof item === "string"
    ? { type: "assumption", text: item, anchor: "" }
    : {
        type: item.type || item.kind || "assumption",
        text: item.text || item.assumption || item.description || "",
        anchor: item.anchor || item.symbol || item.file || "",
      }).filter((item) => item.text);
}

function normalizePaths(pr = {}) {
  return [...new Set([
    ...(pr.paths || []),
    ...(pr.files || []).map((file) => typeof file === "string" ? file : file.filename || file.path),
  ].filter(Boolean))];
}

function evidenceText(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  return item.quote || item.text || item.explanation || item.path || item.file || JSON.stringify(item);
}

function evidenceDetail(item, index) {
  if (typeof item === "string") return { id: `E${index + 1}`, side: "", file: "", symbol: "", line: "", text: item };
  if (!item || typeof item !== "object") return null;
  return {
    id: item.id || `E${index + 1}`,
    side: item.side || item.owner || "",
    file: item.file || item.path || "",
    symbol: item.symbol || item.anchor || "",
    line: item.line || item.lineNumber || "",
    text: evidenceText(item),
  };
}

function findingResources(finding = {}) {
  const explicit = [
    ...(finding.retrievalFeatures?.sharedFiles || []),
    ...(finding.sharedFiles || []),
  ];
  const evidencePaths = (finding.evidence || []).flatMap((item) => {
    if (item && typeof item === "object") return [item.file, item.path].filter(Boolean);
    const text = String(item || "");
    const matches = text.match(/[\w@.-]+(?:\/[\w@.+-]+)+\.[A-Za-z0-9]+/g);
    return matches || [];
  });
  return [...new Set([...explicit, ...evidencePaths].filter(Boolean))];
}

function verificationRuns(finding = {}) {
  const runs = finding.verification?.runs || finding.verification?.states || [];
  if (Array.isArray(runs)) return runs;
  return Object.entries(runs).map(([label, status]) => ({ label, status }));
}

export function adaptBackendResponse(data = {}) {
  const prs = (data.prs || []).map((pr, index) => ({
    id: String(pr.id || pr.number || `pr-${index + 1}`),
    num: pr.number ?? pr.id ?? index + 1,
    title: pr.title || "Untitled pull request",
    author: typeof pr.author === "string" ? pr.author : pr.author?.login || "unknown",
    url: pr.url || pr.html_url || "",
    updatedAt: pr.updatedAt || pr.updated_at || null,
    nFiles: pr.files?.length || pr.paths?.length || 0,
    paths: normalizePaths(pr),
    assumptions: normalizeAssumptions(pr),
  }));
  const byId = new Map(prs.map((pr) => [pr.id, pr]));
  const findings = (data.findings || data.conflicts || []).map((finding, index) => {
    const prIds = (finding.prIds || finding.pr_ids || []).map(String);
    const verdict = ["conflict", "coordination", "review"].includes(finding.verdict)
      ? finding.verdict : "review";
    const basis = finding.basis || finding.source || "backend-judgment";
    const mergeTree = verdict === "coordination" || /merge-tree|textual/i.test(basis)
      ? "textual-conflict" : data.preflight?.complete ? "clean" : "unknown";
    const resources = findingResources(finding);
    const category = finding.category || "semantic-contract";
    const runs = verificationRuns(finding);
    if (!resources.length) resources.push(`contract:${category}`);
    return {
      id: String(finding.id || finding.key || `finding-${index + 1}`),
      prIds,
      verdict,
      title: finding.title || `${verdict} between two pull requests`,
      summary: finding.summary || finding.explanation || "Backend analysis found a relationship that needs attention.",
      category,
      categoryLabel: data.categories?.[category] || category,
      assumptionA: finding.assumptionA || "No explicit assumption was returned.",
      assumptionB: finding.assumptionB || "No explicit assumption was returned.",
      consequence: finding.consequence || finding.impact || "Impact requires reviewer confirmation.",
      recommendation: finding.recommendation || "Review both changes together before merge.",
      evidence: (finding.evidence || []).map(evidenceText).filter(Boolean),
      evidenceDetails: (finding.evidence || []).map(evidenceDetail).filter((item) => item?.text),
      witnesses: (finding.witnesses || []).map((witness) => ({
        title: witness.title || witness.type || "Evidence",
        explanation: witness.explanation || "",
        strength: witness.strength || null,
      })),
      resources,
      basis,
      source: finding.source || "heuristic",
      mergeTree,
      verified: Boolean(finding.verified || runs.length),
      verification: { runs },
    };
  }).filter((finding) => finding.prIds.length === 2 && finding.prIds.every((id) => byId.has(id)))
    .sort((a, b) => (VERDICT_ORDER[a.verdict] ?? 9) - (VERDICT_ORDER[b.verdict] ?? 9));

  const resourceUse = new Map();
  for (const pr of prs) {
    for (const path of pr.paths) {
      const users = resourceUse.get(path) || new Set();
      users.add(pr.id);
      resourceUse.set(path, users);
    }
  }
  for (const finding of findings) {
    for (const resource of finding.resources) {
      const users = resourceUse.get(resource) || new Set();
      finding.prIds.forEach((id) => users.add(id));
      resourceUse.set(resource, users);
    }
  }
  const findingResourcesSet = new Set(findings.flatMap((finding) => finding.resources));
  const resources = [...resourceUse.entries()]
    .map(([path, users]) => ({ id: `resource:${path}`, path, prIds: [...users], total: users.size }))
    .filter((resource) => findingResourcesSet.has(resource.path) || resource.total > 1)
    .sort((a, b) => Number(findingResourcesSet.has(b.path)) - Number(findingResourcesSet.has(a.path)) || b.total - a.total)
    .slice(0, 60);

  const summary = data.summary || {};
  return {
    repository: data.repository || "Backend synthetic sample",
    generatedAt: data.generatedAt || new Date().toISOString(),
    mode: data.mode || "heuristic",
    aiError: data.aiError || null,
    prs,
    findings,
    resources,
    summary: {
      prCount: summary.prCount ?? prs.length,
      pairCount: summary.pairCount ?? (prs.length * (prs.length - 1)) / 2,
      candidateCount: summary.candidateCount ?? findings.length,
      aiReviewedPairCount: summary.aiReviewedPairCount ?? 0,
      conflictCount: summary.conflictCount ?? findings.filter((item) => item.verdict === "conflict").length,
      coordinationCount: summary.coordinationCount ?? findings.filter((item) => item.verdict === "coordination").length,
      reviewCount: summary.reviewCount ?? findings.filter((item) => item.verdict === "review").length,
      independentCount: summary.independentCount ?? 0,
      insufficientCount: summary.insufficientCount ?? 0,
    },
  };
}
