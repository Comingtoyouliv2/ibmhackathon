"use client";

import { useMemo, useState } from "react";
import type { AnalysisResult, Candidate, IntentCard } from "../lib/analyzer";

type EdgeKind = "text" | "combined" | "clean" | "llm" | "uncertain" | "static" | "candidate";
type GraphEdge = Candidate & { id: string; kind: EdgeKind; label: string; rationale: string; evidence: string[] };
type Selection = { type: "edge"; id: string } | { type: "node"; pr: number } | null;

const pairKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;

function edgeClass(kind: EdgeKind) {
  return kind === "clean" || kind === "candidate" ? "edgeCombinedClean" : "edgeConflict";
}

function binaryLabel(kind: EdgeKind) {
  return kind === "clean" || kind === "candidate" ? "안 충돌" : "충돌";
}

function keyboardSelect(event: React.KeyboardEvent, action: () => void) {
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); action(); }
}

export function ConflictGraph({ result }: { result: AnalysisResult }) {
  const allNodes = result.pairMergeCards ?? result.cards;
  const edges = useMemo<GraphEdge[]>(() => {
    const textKeys = new Set((result.pairTextConflicts ?? []).map((pair) => pairKey(pair.a, pair.b)));
    const rows = new Map<string, GraphEdge>();
    const put = (pair: Candidate, kind: EdgeKind, label: string, rationale: string, evidence: string[] = []) => {
      const id = pairKey(pair.a, pair.b);
      const priority: EdgeKind[] = ["candidate", "uncertain", "llm", "static", "clean", "combined", "text"];
      if (!rows.has(id) || priority.indexOf(kind) > priority.indexOf(rows.get(id)!.kind)) rows.set(id, { ...pair, id, kind, label, rationale, evidence });
    };
    for (const pair of result.semanticCandidates ?? result.candidates) put(
      pair,
      "candidate",
      "안 충돌",
      `후보 인덱스가 ${pair.joinReasons?.join(", ") || "shared contract"} 신호로 검사했지만 충돌 근거는 발견되지 않았습니다.`,
    );
    for (const pair of result.needsVerification ?? []) put(pair, "uncertain", "충돌", pair.rationale, pair.evidence);
    for (const pair of result.conflicts) put(pair, "static", "충돌", pair.rationale, pair.evidence);
    for (const pair of result.llmFindings ?? []) if (!textKeys.has(pairKey(pair.a, pair.b))) put(pair, pair.verdict === "llm_conflict" ? "llm" : "uncertain", "충돌", pair.claim, pair.evidence.map((item) => `${item.file}: ${item.quote}`));
    for (const pair of result.combinedVerifications ?? []) if (!textKeys.has(pairKey(pair.a, pair.b))) put(pair, pair.verdict === "combined_conflict" ? "combined" : pair.verdict === "combined_clean" ? "clean" : "uncertain", pair.verdict === "combined_clean" ? "안 충돌" : "충돌", pair.rationale, pair.evidence);
    for (const pair of result.pairTextConflicts ?? []) put(pair, "text", "충돌", pair.rationale, pair.evidence);
    return [...rows.values()].sort((a, b) => a.a - b.a || a.b - b.b);
  }, [result]);

  const [requestedSelection, setSelection] = useState<Selection>(null);
  const selection = requestedSelection?.type === "edge" && edges.some((edge) => edge.id === requestedSelection.id)
    ? requestedSelection
    : requestedSelection?.type === "node" && allNodes.some((node) => node.pr === requestedSelection.pr)
      ? requestedSelection
      : edges[0] ? { type: "edge" as const, id: edges[0].id } : null;
  const connected = new Set(edges.flatMap((pair) => [pair.a, pair.b]));
  const degree = new Map<number, number>();
  for (const pair of edges) { degree.set(pair.a, (degree.get(pair.a) ?? 0) + 1); degree.set(pair.b, (degree.get(pair.b) ?? 0) + 1); }
  const nodes = allNodes.filter((card) => connected.has(card.pr)).sort((a, b) => (degree.get(b.pr) ?? 0) - (degree.get(a.pr) ?? 0) || a.pr - b.pr).slice(0, 120);
  const visible = new Set(nodes.map((card) => card.pr));
  const visibleEdges = edges.filter((edge) => visible.has(edge.a) && visible.has(edge.b));
  const size = 680, center = size / 2, radius = nodes.length < 3 ? 130 : 245;
  const points = new Map(nodes.map((card, index) => { const angle = index / Math.max(nodes.length, 1) * Math.PI * 2 - Math.PI / 2; return [card.pr, { x: center + Math.cos(angle) * radius, y: center + Math.sin(angle) * radius }] as const; }));
  const cards = new Map(allNodes.map((card) => [card.pr, card]));
  const totalEligible = result.pairMergePrs ?? result.eligiblePrs;

  if (totalEligible === 0) return <div className="graphEmpty">게이트를 통과한 PR이 없어 그래프를 생성하지 않았습니다.</div>;
  if (nodes.length === 0) return <div className="graphEmpty"><b>{totalEligible} eligible PRs</b><span>PR 간 계약 edge가 없습니다.</span></div>;

  const selectedEdge = selection?.type === "edge" ? edges.find((edge) => edge.id === selection.id) : undefined;
  const selectedNode = selection?.type === "node" ? cards.get(selection.pr) : undefined;
  return (
    <div className="graphPanel">
      <div className="graphTitle"><div><span className="sectionNo">INTERACTIVE RELATION MAP</span><h3>PR conflict graph</h3><small>결론은 충돌/안 충돌이며, 클릭하면 판정 근거를 볼 수 있습니다.</small></div><div className="legend"><span><i className="conflictDot" />충돌</span><span><i className="combinedCleanDot" />안 충돌</span></div></div>
      <svg className="graph" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${totalEligible} eligible PRs, ${nodes.length} connected nodes, ${visibleEdges.length} relations`}>
        {visibleEdges.map((edge) => { const a = points.get(edge.a)!; const b = points.get(edge.b)!; const select = () => setSelection({ type: "edge", id: edge.id }); return <line key={edge.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`${edgeClass(edge.kind)} graphEdge ${selectedEdge?.id === edge.id ? "isSelected" : ""}`} role="button" tabIndex={0} aria-label={`PR ${edge.a} and PR ${edge.b}: ${edge.label}`} onClick={select} onKeyDown={(event) => keyboardSelect(event, select)}><title>{edge.label}: {edge.rationale}</title></line>; })}
        {nodes.map((card) => { const point = points.get(card.pr)!; const incident = visibleEdges.filter((edge) => edge.a === card.pr || edge.b === card.pr); const strongest = incident.find((edge) => edge.kind === "text")?.kind ?? incident.find((edge) => edge.kind === "combined")?.kind ?? incident.find((edge) => edge.kind === "llm")?.kind ?? incident.find((edge) => edge.kind === "uncertain")?.kind ?? incident[0]?.kind ?? "candidate"; const select = () => setSelection({ type: "node", pr: card.pr }); return <g key={card.pr} transform={`translate(${point.x} ${point.y})`} className={`graphNode ${selectedNode?.pr === card.pr ? "isSelected" : ""}`} role="button" tabIndex={0} aria-label={`PR ${card.pr}: ${card.title}`} onClick={select} onKeyDown={(event) => keyboardSelect(event, select)}><circle r={25 + Math.min(12, degree.get(card.pr) ?? 0)} className={`node-${strongest}`} /><text textAnchor="middle" dy="4">#{card.pr}</text><title>{card.title}</title></g>; })}
      </svg>
      <GraphDetail edge={selectedEdge} node={selectedNode} cards={cards} incident={selectedNode ? visibleEdges.filter((edge) => edge.a === selectedNode.pr || edge.b === selectedNode.pr) : []} onSelectEdge={(id) => setSelection({ type: "edge", id })} />
    </div>
  );
}

function GraphDetail({ edge, node, cards, incident, onSelectEdge }: { edge?: GraphEdge; node?: IntentCard; cards: Map<number, IntentCard>; incident: GraphEdge[]; onSelectEdge: (id: string) => void }) {
  if (edge) return <section className="graphDetail" aria-live="polite">
    <div className="graphDetailTop"><div><span>{edge.label}</span><h4>PR #{edge.a} ↔ PR #{edge.b}</h4></div><b>{binaryLabel(edge.kind)}</b></div>
    <div className="graphPairTitles"><span>#{edge.a} {cards.get(edge.a)?.title}</span><span>#{edge.b} {cards.get(edge.b)?.title}</span></div>
    <div className="graphExplanationGrid">
      <div><small>WHY THIS PAIR WAS SELECTED</small><p>{edge.joinReasons?.length ? edge.joinReasons.join(" · ") : "verified result imported from the scan artifact"}</p><div className="graphMeta">{edge.candidateTier && <b>{edge.candidateTier} tier</b>}{edge.candidateScore !== undefined && <b>score {edge.candidateScore.toFixed(1)}</b>}{edge.candidateSources?.map((source) => <b key={source}>{source}</b>)}</div></div>
      <div><small>WHY IT HAS THIS VERDICT</small><p>{edge.rationale}</p></div>
    </div>
    <div className="graphResources">{edge.sharedResources.slice(0, 12).map((resource) => <code key={resource}>{resource}</code>)}</div>
    {edge.evidence.length > 0 && <details><summary>직접 근거 {edge.evidence.length}개</summary>{edge.evidence.slice(0, 10).map((item, index) => <code key={index}>{item}</code>)}</details>}
  </section>;
  if (node) return <section className="graphDetail" aria-live="polite">
    <div className="graphDetailTop"><div><span>SELECTED PR</span><h4>#{node.pr} {node.title}</h4></div><b>{incident.length} edges</b></div>
    {node.url && <a className="graphPrLink" href={node.url} target="_blank" rel="noreferrer">Open pull request ↗</a>}
    <div className="graphExplanationGrid"><div><small>TOUCHED CONTRACTS</small><div className="graphResources">{node.touchedResources.slice(0, 10).map((resource) => <code key={resource}>{resource}</code>)}</div></div><div><small>EXTRACTED ASSUMPTIONS</small>{node.assumptions.slice(0, 4).map((assumption) => <p key={assumption}>{assumption}</p>)}</div></div>
    <div className="graphNeighbors">{incident.slice(0, 16).map((edge) => <button type="button" key={edge.id} onClick={() => onSelectEdge(edge.id)}>#{edge.a === node.pr ? edge.b : edge.a} · {edge.label}</button>)}</div>
  </section>;
  return <section className="graphDetail"><span>노드 또는 연결선을 선택하세요.</span></section>;
}
