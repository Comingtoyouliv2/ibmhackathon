import type { AnalysisResult, Candidate, IntentCard } from "../lib/analyzer";

const pairKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;

function PairLane({
  pairs,
  cards,
  kind,
  superseded,
}: {
  pairs: Candidate[];
  cards: Map<number, IntentCard>;
  kind: "text" | "semantic";
  superseded: Set<string>;
}) {
  const rowHeight = 58;
  const height = Math.max(92, pairs.length * rowHeight + 26);
  if (pairs.length === 0) return <div className="comparisonEmpty">No {kind === "text" ? "code-detected text conflicts" : "LLM semantic findings"} in this repository.</div>;
  return (
    <svg className="comparisonGraph" viewBox={`0 0 520 ${height}`} role="img" aria-label={`${pairs.length} ${kind} PR conflict pairs shown`}>
      <title>{kind === "text" ? "Code-detected Git text conflict pairs" : "LLM-detected semantic conflict pairs"}</title>
      <desc>Each row connects two pull request nodes. Edge color and label identify the conflict source and status.</desc>
      {pairs.map((pair, index) => {
        const y = index * rowHeight + 18;
        const a = cards.get(pair.a);
        const b = cards.get(pair.b);
        const key = pairKey(pair.a, pair.b);
        const isSuperseded = superseded.has(key);
        const verdict = "verdict" in pair ? String(pair.verdict) : kind;
        const edgeClass = kind === "text" ? "comparisonEdgeText" : isSuperseded ? "comparisonEdgeSuperseded" : verdict === "llm_conflict" ? "comparisonEdgeLlm" : "comparisonEdgeUncertain";
        const label = "충돌";
        return (
          <g key={key} className="comparisonPair">
            <line x1="112" y1={y + 13} x2="408" y2={y + 13} className={edgeClass} />
            <rect x="8" y={y - 4} width="104" height="34" rx="2" className={kind === "text" ? "comparisonNodeText" : "comparisonNodeLlm"} />
            <rect x="408" y={y - 4} width="104" height="34" rx="2" className={kind === "text" ? "comparisonNodeText" : "comparisonNodeLlm"} />
            <text x="60" y={y + 17} textAnchor="middle" className="comparisonPr">#{pair.a}</text>
            <text x="460" y={y + 17} textAnchor="middle" className="comparisonPr">#{pair.b}</text>
            <rect x="218" y={y + 2} width="84" height="22" rx="11" className={`comparisonLabel ${edgeClass}`} />
            <text x="260" y={y + 17} textAnchor="middle" className="comparisonLabelText">{label}</text>
            <title>#{pair.a} {a?.title ?? "Unknown PR"} ↔ #{pair.b} {b?.title ?? "Unknown PR"}\n{pair.sharedResources.join(", ")}</title>
          </g>
        );
      })}
    </svg>
  );
}

export function ConflictComparisonGraph({ result }: { result: AnalysisResult }) {
  const cards = new Map((result.pairMergeCards ?? result.cards).map((card) => [card.pr, card]));
  const textPairs = result.pairTextConflicts ?? [];
  const llmPairs = result.llmFindings ?? [];
  const textKeys = new Set(textPairs.map((pair) => pairKey(pair.a, pair.b)));
  const verifiedKeys = new Set((result.combinedVerifications ?? []).map((pair) => pairKey(pair.a, pair.b)));
  const shownText = [...textPairs]
    .sort((left, right) => Number(verifiedKeys.has(pairKey(right.a, right.b))) - Number(verifiedKeys.has(pairKey(left.a, left.b))) || left.a - right.a || left.b - right.b)
    .slice(0, 12);
  const shownLlm = [...llmPairs]
    .sort((left, right) => Number(textKeys.has(pairKey(right.a, right.b))) - Number(textKeys.has(pairKey(left.a, left.b))) || Number(right.verdict === "llm_conflict") - Number(left.verdict === "llm_conflict") || left.a - right.a || left.b - right.b)
    .slice(0, 12);
  const activeLlm = llmPairs.filter((pair) => pair.verdict === "llm_conflict" && !textKeys.has(pairKey(pair.a, pair.b))).length;
  const uncertain = llmPairs.filter((pair) => pair.verdict === "llm_uncertain" && !textKeys.has(pairKey(pair.a, pair.b))).length;
  const superseded = llmPairs.filter((pair) => textKeys.has(pairKey(pair.a, pair.b))).length;

  return (
    <section className="comparisonPanel" aria-labelledby="comparison-title">
      <div className="comparisonHead">
        <div><span className="sectionNo">CONFLICT EVIDENCE COMPARISON</span><h3 id="comparison-title">충돌 근거 비교</h3></div>
        <span className="comparisonNote">결론은 모두 충돌이며 Git/의미 분석은 판정 근거만 구분합니다.</span>
      </div>
      <div className="comparisonGrid">
        <div className="comparisonLane textLane">
          <div className="comparisonLaneHead"><span>CODE / GIT</span><b>{textPairs.length}</b><small>same-base text conflicts · top {shownText.length}</small></div>
          <PairLane pairs={shownText} cards={cards} kind="text" superseded={new Set()} />
          {textPairs.length > shownText.length && <small className="comparisonRemainder">+ {textPairs.length - shownText.length} more text-conflict edges</small>}
        </div>
        <div className="comparisonLane llmLane">
          <div className="comparisonLaneHead"><span>LLM / SEMANTIC</span><b>{activeLlm}</b><small>{uncertain} 검토 필요 · {superseded} Git 충돌로 재분류 · top {shownLlm.length}</small></div>
          <PairLane pairs={shownLlm} cards={cards} kind="semantic" superseded={textKeys} />
          {llmPairs.length > shownLlm.length && <small className="comparisonRemainder">+ {llmPairs.length - shownLlm.length} more semantic edges</small>}
        </div>
      </div>
    </section>
  );
}
