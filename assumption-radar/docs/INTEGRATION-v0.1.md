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

## v0.2 — Claude submission integration

The teammate's runnable Claude submission was rescored with the same private gold before integration:

- pair judgment: precision 90.0%, recall 90.0%, F1 90.0%
- end-to-end radar: MAP@20 82.6%, Recall@10 80.0%, Recall@20 100.0%

Its pair judge found three positives missed by the deterministic judge, while the existing integrated retrieval still ranked pairs better. v0.2 therefore keeps the v0.1 ranking and adds only the transferable parts of the Claude system:

- bounded second-look lane for high-retrieval pairs currently labelled independent
- compact per-pair dossiers built from shared files, modules, symbols, witnesses, and Contract Cards
- isolated Anthropic calls with a concurrency cap
- robust JSON control-character repair
- a bilateral evidence gate: an AI blocker needs a verbatim quote from both PRs
- provider selection between OpenAI and Anthropic

The benchmark-only `modules/m-*` shortcut was deliberately not integrated. Repository modules are inferred through the existing generic resource model instead.

Using the teammate's frozen Claude outputs to test the fusion policy gives pair precision 90.9%, recall 100.0%, F1 95.2%, blocker precision/recall 100.0%/100.0%. This is a regression experiment, not a fresh model run or an OSS generalization claim. Reproduce it with:

```bash
npm run compare:claude-fusion
node eval/evaluate-pair-qualification.mjs \
  benchmarks/semantic-clean-v0.1/frozen-v0.1/gold.jsonl \
  benchmarks/comparisons/integrated-v0.2-claude-frozen/pair/predictions.jsonl \
  benchmarks/comparisons/integrated-v0.2-claude-frozen/pair-score
```

## v0.2 — live Codex replacement run

The same second-look interface can use an authenticated local Codex CLI without an Anthropic or OpenAI API key. A fresh, gold-blind run used 23 isolated Codex calls for the 40-case pair suite; deterministic blockers bypassed the model.

- model: `gpt-5.4`, reasoning effort `medium`
- wall time: 123.6 seconds
- precision 90.5%, recall 95.0%, F1 92.7%
- blocker precision 100.0%, blocker recall 95.0%
- false blocker rate 0.0%

This improves on the deterministic pair F1 of 89.5%, but remains below the frozen Claude-fusion F1 of 95.2%. One positive remained missed and two harmless cases were routed to review. Reproduce a fresh run with:

This is a system-level ablation, not a same-prompt model-only comparison: deterministic findings are preserved, and Codex sees the integrated detector's compact second-look case and internal prompt. The public suite prompt hash in `run.json` identifies the input/output protocol; `notes` records this internal-prompt distinction explicitly.

```bash
npm run compare:codex-live -- --model gpt-5.4 --concurrency 4
node eval/evaluate-pair-qualification.mjs \
  benchmarks/semantic-clean-v0.1/frozen-v0.1/gold.jsonl \
  benchmarks/comparisons/integrated-v0.2-codex-live/pair/predictions.jsonl \
  benchmarks/comparisons/integrated-v0.2-codex-live/pair-score
```
