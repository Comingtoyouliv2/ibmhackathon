# End-to-End Radar Arena result

- Episodes: 2
- PRs: 80 total (40 / 40 per episode)
- Candidate pairs: 1560
- Gold conflict pairs: 20
- Historical hard negatives: 20
- Mean Average Precision@20: 35.7%

| Budget | Macro recall | Macro precision | Pair reduction |
|---:|---:|---:|---:|
| 5 | 10.0% | 20.0% | 99.4% |
| 10 | 50.0% | 50.0% | 98.7% |
| 20 | 80.0% | 40.0% | 97.4% |

## Episodes

### radar-arena-v0.1-episode-01

- AP@20: 36.8%
- Recall@5/10/20: 10.0% / 50.0% / 80.0%
- Precision@5/10/20: 20.0% / 50.0% / 40.0%
- Historical hard negatives in top 20: 0
- Isolated-module controls in top 20: 12

### radar-arena-v0.1-episode-02

- AP@20: 34.5%
- Recall@5/10/20: 10.0% / 50.0% / 80.0%
- Precision@5/10/20: 20.0% / 50.0% / 40.0%
- Historical hard negatives in top 20: 0
- Isolated-module controls in top 20: 12

## Missed conflict pairs at top 20 (4)

- `radar-arena-v0.1-episode-01:PR-022:PR-037` · maxcom/lorsource · remove-vs-reference
- `radar-arena-v0.1-episode-01:PR-025:PR-040` · gwtbootstrap3/gwtbootstrap3 · behavioral-composition
- `radar-arena-v0.1-episode-02:PR-002:PR-013` · caelum/vraptor4 · behavioral-composition
- `radar-arena-v0.1-episode-02:PR-037:PR-039` · timmolter/XChart · rename-vs-reference

> This controlled arena measures pair discovery plus judgment over anonymized historical changes in isolated monorepo modules. It is not evidence of natural open-PR prevalence or cross-language generalization.
