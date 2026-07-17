# Scikit-learn seed baseline

- Gold: `gold.jsonl`
- Predictions: `predictions.jsonl`
- Generated: 2026-07-15T02:27:09.074Z

## Dataset

- 5 raw cases
- 3 independent relationship cases
- 2 filtered stack/alias controls
- 1 silent semantic cases

## Baseline

- Stack/alias filter recall: 100.0% (2/2)
- Exact relationship accuracy: 100.0% (3/3)
- Coordination recall: 100.0% (2/2)
- Coordination subtype accuracy: 0.0% (0/2)
- Required-action accuracy: 0.0% (0/2)
- Silent compatible exact rate: 100.0%
- Silent harmless review rate: 0.0%

## Errors

- None

## Explanation and action gaps

- `scikit-learn/scikit-learn#34393x34464` · coordination-subtype: expected `resolution-risk`, got `missing`
- `scikit-learn/scikit-learn#34393x34464` · required-action: expected `preserve-regression-fix`, got `resolve-textual-conflict`
- `scikit-learn/scikit-learn#32511x34465` · coordination-subtype: expected `duplicate-implementation`, got `missing`
- `scikit-learn/scikit-learn#32511x34465` · required-action: expected `deduplicate`, got `resolve-textual-conflict`

> This seed is a regression anchor, not a generalization claim. The sample is too small and comes from one repository.
