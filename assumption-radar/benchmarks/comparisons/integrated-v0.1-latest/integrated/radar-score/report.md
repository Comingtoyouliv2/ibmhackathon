# End-to-End Radar Arena result

- Episodes: 2
- PRs: 80 total (40 / 40 per episode)
- Candidate pairs: 1560
- Gold conflict pairs: 20
- Historical hard negatives: 20
- Mean Average Precision@20: 94.3%

| Budget | Macro recall | Macro precision | Pair reduction |
|---:|---:|---:|---:|
| 5 | 50.0% | 100.0% | 99.4% |
| 10 | 85.0% | 85.0% | 98.7% |
| 20 | 100.0% | 50.0% | 97.4% |

## Episodes

### radar-arena-v0.1-episode-01

- AP@20: 91.9%
- Recall@5/10/20: 50.0% / 80.0% / 100.0%
- Precision@5/10/20: 100.0% / 80.0% / 50.0%
- Historical hard negatives in top 20: 10
- Isolated-module controls in top 20: 0

### radar-arena-v0.1-episode-02

- AP@20: 96.7%
- Recall@5/10/20: 50.0% / 90.0% / 100.0%
- Precision@5/10/20: 100.0% / 90.0% / 50.0%
- Historical hard negatives in top 20: 9
- Isolated-module controls in top 20: 1

## Missed conflict pairs at top 20 (0)

- None

> This controlled arena measures pair discovery plus judgment over anonymized historical changes in isolated monorepo modules. It is not evidence of natural open-PR prevalence or cross-language generalization.
