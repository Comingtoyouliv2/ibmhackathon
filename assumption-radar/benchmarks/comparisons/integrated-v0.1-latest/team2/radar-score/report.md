# End-to-End Radar Arena result

- Episodes: 2
- PRs: 80 total (40 / 40 per episode)
- Candidate pairs: 1560
- Gold conflict pairs: 20
- Historical hard negatives: 20
- Mean Average Precision@20: 64.4%

| Budget | Macro recall | Macro precision | Pair reduction |
|---:|---:|---:|---:|
| 5 | 30.0% | 60.0% | 99.4% |
| 10 | 55.0% | 55.0% | 98.7% |
| 20 | 100.0% | 50.0% | 97.4% |

## Episodes

### radar-arena-v0.1-episode-01

- AP@20: 54.6%
- Recall@5/10/20: 20.0% / 50.0% / 100.0%
- Precision@5/10/20: 40.0% / 50.0% / 50.0%
- Historical hard negatives in top 20: 10
- Isolated-module controls in top 20: 0

### radar-arena-v0.1-episode-02

- AP@20: 74.3%
- Recall@5/10/20: 40.0% / 60.0% / 100.0%
- Precision@5/10/20: 80.0% / 60.0% / 50.0%
- Historical hard negatives in top 20: 10
- Isolated-module controls in top 20: 0

## Missed conflict pairs at top 20 (0)

- None

> This controlled arena measures pair discovery plus judgment over anonymized historical changes in isolated monorepo modules. It is not evidence of natural open-PR prevalence or cross-language generalization.
