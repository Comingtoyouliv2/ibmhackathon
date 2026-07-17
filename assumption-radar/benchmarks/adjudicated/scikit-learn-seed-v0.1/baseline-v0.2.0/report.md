# Scikit-learn seed baseline

- Gold: `gold.jsonl`
- Predictions: `predictions.jsonl`
- Generated: 2026-07-15T02:20:23.265Z

## Dataset

- 5 raw cases
- 3 independent relationship cases
- 2 filtered stack/alias controls
- 1 silent semantic cases

## Baseline

- Stack/alias filter recall: 100.0% (2/2)
- Exact relationship accuracy: 66.7% (2/3)
- Coordination recall: 100.0% (2/2)
- Coordination subtype accuracy: 0.0% (0/2)
- Required-action accuracy: 0.0% (0/2)
- Silent compatible exact rate: 0.0%
- Silent harmless review rate: 100.0%

## Errors

- `scikit-learn/scikit-learn#33906x34377`: expected `compatible`, got `review`

> This seed is a regression anchor, not a generalization claim. The sample is too small and comes from one repository.
