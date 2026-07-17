# Semantic conflict integration v0.1

## Purpose

This version combines selected features from three approaches without allowing a weak contextual signal to erase or manufacture a deterministic blocker.

## Integrated features

### Existing Assumption Radar core

- base normalization, stack collapse, merge-tree preflight
- language adapters and SCIR
- directional contract witnesses
- deterministic blocker policy
- pair qualification and end-to-end radar evaluation

### Team 1-derived features

- patch-level read/write, collection mutation, and adjacent control-flow interaction signals
- normalized repeated failure signatures for Base/A/B/A+B execution
- conservative policy: patch interaction is retrieval evidence until context or execution confirms a contradiction

### Team 2 design-derived features

- per-PR Contract Card
- namespaced file/module/API/event/config/schema/symbol resources
- IDF-weighted resource intersection
- intent-token similarity
- retrieval ranking that keeps exact contract/file evidence ahead of generic symbol similarity

The Team 2 standalone result is explicitly a retrieval prototype. Its planned Step-3 LLM semantic judge has not been implemented and is not assigned fabricated performance.

## Frozen benchmark result

### Pair judgment — 40 clean pairs

| System | Precision | Recall | F1 | Blocker precision | Blocker recall |
|---|---:|---:|---:|---:|---:|
| Current v0.9 | 94.4% | 85.0% | 89.5% | 100.0% | 85.0% |
| Team 1 behavior submission | 80.0% | 60.0% | 68.6% | 50.0% | 5.0% |
| Team 2 retrieval prototype | 50.0% | 100.0% | 66.7% | n/a | 0.0% |
| Integrated v0.1 | **94.4%** | **85.0%** | **89.5%** | **100.0%** | **85.0%** |

The first naive integration routed patch interactions directly to review. Recall increased to 90%, but precision fell to 69.2%. That version was rejected. In the accepted integration, patch effects affect retrieval and explanation but need stronger evidence before changing the pair verdict.

### End-to-end radar — 80 PRs, 1,560 pairs

| System | MAP@20 | Recall@5 | Recall@10 | Recall@20 |
|---|---:|---:|---:|---:|
| Current v0.9 | 35.7% | 10.0% | 50.0% | 80.0% |
| Team 1 behavior submission | 70.6% | 30.0% | 60.0% | 100.0% |
| Team 2 retrieval prototype | 64.4% | 30.0% | 55.0% | 100.0% |
| Integrated v0.1 | **94.3%** | **50.0%** | **85.0%** | **100.0%** |

## Interpretation

The integration fixes the controlled arena's main failure mode: structurally related independent pairs were previously ranked below accidental cross-module symbol matches. It preserves the current pair judge while using Contract Cards and patch effects to order the review queue.

This is not yet an OSS generalization result. The arena intentionally places related historical changes in isolated modules, so module-aware retrieval has a valid but unusually clean signal. The next gate is an unchanged run on one real repository snapshot followed by transfer to a second repository without retuning.

## Reproduce

The command below reruns current, Team 2 prototype, and integrated code. It reuses Team 1's already-frozen model predictions from the exact same suite instead of spending another model run.

```bash
npm run compare:integrated -- benchmarks/comparisons/integrated-v0.1-latest
```

To use a different frozen Team 1 submission:

```bash
node eval/run-integrated-comparison.mjs OUTPUT_DIR TEAM1_RESULT_DIR
```
