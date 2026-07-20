import { createHash } from "node:crypto";

export const stableHash = (value) => createHash("sha256")
  .update(JSON.stringify(value))
  .digest("hex");

export function aggregateRepeatedVerdicts(verdicts, expectedCount = verdicts.length) {
  const valid = verdicts.filter(Boolean);
  const counts = Object.fromEntries([...new Set(valid)].map((verdict) => [verdict, valid.filter((item) => item === verdict).length]));
  const complete = valid.length === expectedCount;
  if (!valid.length) return { verdict: "insufficient", stable: false, complete, completedCount: 0, expectedCount, counts };
  if (complete && Object.keys(counts).length === 1) {
    return { verdict: valid[0], stable: true, complete, completedCount: valid.length, expectedCount, counts };
  }
  return { verdict: "review", stable: false, complete, completedCount: valid.length, expectedCount, counts };
}

export function semanticOutcome(gold, prediction) {
  if (gold === "conflict") return ["conflict", "review"].includes(prediction);
  return prediction === "independent";
}

export function compareFrozenPredictions(goldRecords, previousPredictions = [], currentPredictions = []) {
  const goldById = new Map(goldRecords.map((record) => [record.id, record]));
  const previousById = new Map(previousPredictions.map((record) => [record.id, record]));
  const currentById = new Map(currentPredictions.map((record) => [record.id, record]));
  const rows = [];
  const counts = { improved: 0, regressed: 0, changed: 0, unchanged: 0, newBaseline: 0, missing: 0 };

  for (const [id, gold] of goldById) {
    const previous = previousById.get(id);
    const current = currentById.get(id);
    if (!current) {
      counts.missing += 1;
      rows.push({ id, gold: gold.gold, previous: previous?.prediction ?? null, current: null, change: "missing" });
      continue;
    }
    if (!previous) {
      counts.newBaseline += 1;
      rows.push({ id, gold: gold.gold, previous: null, current: current.prediction, change: "new-baseline" });
      continue;
    }
    if (previous.prediction === current.prediction) {
      counts.unchanged += 1;
      continue;
    }
    const beforeCorrect = semanticOutcome(gold.gold, previous.prediction);
    const afterCorrect = semanticOutcome(gold.gold, current.prediction);
    const change = !beforeCorrect && afterCorrect ? "improved" : beforeCorrect && !afterCorrect ? "regressed" : "changed";
    counts[change] += 1;
    rows.push({ id, gold: gold.gold, previous: previous.prediction, current: current.prediction, change });
  }
  return { counts, rows };
}

function byLogicalKey(snapshot) {
  return new Map((snapshot?.findings || []).map((finding) => [finding.logicalKey, finding]));
}

function itemsByLogicalKey(snapshot, field) {
  return new Map((snapshot?.[field] || []).map((item) => [item.logicalKey, item]));
}

function compareSelectedItems(previous, current, field) {
  const before = itemsByLogicalKey(previous, field);
  const after = itemsByLogicalKey(current, field);
  const result = { new: [], changed: [], outOfScope: [], unchanged: 0 };
  for (const [key, item] of after) {
    const prior = before.get(key);
    if (!prior) result.new.push(item);
    else if (prior.inputFingerprint !== item.inputFingerprint) result.changed.push({ logicalKey: key, previous: prior, current: item, inputChanged: true });
    else result.unchanged += 1;
  }
  for (const [key, item] of before) if (!after.has(key)) result.outOfScope.push(item);
  result.counts = {
    new: result.new.length,
    changed: result.changed.length,
    outOfScope: result.outOfScope.length,
    unchanged: result.unchanged,
  };
  return result;
}

export function compareLiveSnapshots(previous, current) {
  if (!previous) {
    return {
      previousSnapshot: null,
      counts: { new: current.findings.length, changed: 0, cleared: 0, outOfScope: 0, unchanged: 0 },
      new: current.findings,
      changed: [],
      cleared: [],
      outOfScope: [],
      exploration: compareSelectedItems(null, current, "explorationControls"),
      selectedAlerts: compareSelectedItems(null, current, "selectedAlerts"),
    };
  }
  const previousByKey = byLogicalKey(previous);
  const currentByKey = byLogicalKey(current);
  const currentPrNumbers = new Set((current.prs || []).map((pr) => Number(pr.number)));
  const diff = { previousSnapshot: previous.generatedAt, new: [], changed: [], cleared: [], outOfScope: [] };
  let unchanged = 0;

  for (const [key, finding] of currentByKey) {
    const before = previousByKey.get(key);
    if (!before) {
      diff.new.push(finding);
      continue;
    }
    if (before.inputFingerprint === finding.inputFingerprint && before.findingFingerprint === finding.findingFingerprint) {
      unchanged += 1;
      continue;
    }
    diff.changed.push({
      logicalKey: key,
      prNumbers: finding.prNumbers,
      previous: { verdict: before.verdict, basis: before.basis, inputFingerprint: before.inputFingerprint },
      current: { verdict: finding.verdict, basis: finding.basis, source: finding.source, inputFingerprint: finding.inputFingerprint },
      inputChanged: before.inputFingerprint !== finding.inputFingerprint,
      verdictChanged: before.verdict !== finding.verdict,
      basisChanged: before.basis !== finding.basis,
    });
  }

  for (const [key, finding] of previousByKey) {
    if (currentByKey.has(key)) continue;
    const bucket = finding.prNumbers.every((number) => currentPrNumbers.has(Number(number))) ? diff.cleared : diff.outOfScope;
    bucket.push(finding);
  }
  diff.counts = {
    new: diff.new.length,
    changed: diff.changed.length,
    cleared: diff.cleared.length,
    outOfScope: diff.outOfScope.length,
    unchanged,
  };
  diff.exploration = compareSelectedItems(previous, current, "explorationControls");
  diff.selectedAlerts = compareSelectedItems(previous, current, "selectedAlerts");
  return diff;
}
