# EXECUTION — Semantic Conflict Evaluation Suite v0.1

## System

- **System name**: assumption-radar (pair-judge + e2e radar)
- **Version**: 0.1.0 (no git repo; ad-hoc run harness authored for this evaluation)
- **Model (all AI decisions)**: `claude-opus-4-8` (Claude Opus 4.8). Each AI decision ran as an isolated Claude Code subagent inheriting the session model.
- **Deterministic vs AI split**:
  - *Deterministic (Node.js v24.14.1, no network)*: parsing inputs/episodes, extracting shared files, changed-symbol sets (regex for Java method/type defs and call sites), module membership (`modules/m-*` path prefix), pair candidate generation and overlap scoring, dossier construction, submission assembly, JSON repair, and evidence-verbatim sanitation.
  - *AI (Opus 4.8)*: the label/decision for every pair (Test 1) and the ranking + decision of the candidate pairs (Test 2). The AI never saw gold, fixing commits, other systems' predictions, or information beyond the supplied case/episode files.

## Model settings

- Temperature / determinism: **`claude-opus-4-8` does not accept `temperature`, `top_p`, or `top_k` — sending any of them returns HTTP 400.** Per the rule "temperature is 0 **or the most deterministic setting the model supports**", the compliant configuration on this model is to send **no sampling parameters** and pin `output_config.effort` instead. That is what the API runner does (`work/run-pair-judge.mjs`, `work/run-e2e-rank.mjs`). The judging reported below additionally ran through the Claude Code subagent harness, which likewise exposes no sampling knob. No sampling parameters were tuned.
- No retries were scripted; every case/episode succeeded on first execution (0 failures). One-time, post-hoc *format* repairs were applied to already-produced outputs (see "Failures / repairs") — no re-judging or prompt tuning occurred.
- Parallelism: pair cases were judged concurrently under the harness concurrency cap (~10 simultaneous subagents); episodes ranked concurrently (2 subagents).

## Fixed prompts (unmodified)

- Test 1 combined prompt SHA-256: `d0eb938811d1778b114c9db483f8d4f52a9ee65afc451641c60cfa7d5dbf1c90` (matches `PROMPT_SHA256.txt`).
- Test 2 task prompt SHA-256: `87d2dca2f61f9aae1ec77501c091eb2fb8b9f8de696d2f06accd83efada6c88e` (matches `TASK_PROMPT_SHA256.txt`).
- `SYSTEM_PROMPT.txt` / `USER_PROMPT_TEMPLATE.txt` / `TASK_PROMPT.txt` were read unchanged; only `{{CASE_JSON}}` handling and the preprocessed dossier were provided to the model.

## Test 1 — Pair Judgment (40 cases)

1. `work/analyze-pairs.mjs` split the 40-case `inputs.jsonl` (12 MB) into per-case dossiers (`work/pair/case-NN.md`) containing: shared files with both sides' hunks, cross-symbol signals (A-defines&B-calls, B-defines&A-calls, symbols changed by both), and file lists.
2. One isolated subagent per case read `SYSTEM_PROMPT.txt` (unchanged) + only that case's dossier, and wrote one prediction JSON (`work/pair/pred-NN.json`). Each subagent saw exactly one case (no cross-case leakage).
3. `work/assemble-pair.mjs` concatenated predictions in `inputs.jsonl` order into `submission/pair-qualification-predictions.jsonl`.
4. Validator passed: `Submission valid: 40 predictions, 40 unique input cases.`
- Label distribution: conflict 11, coordination 9, independent 20.

### Actual commands (Test 1)
```bash
node work/analyze-pairs.mjs                 # build per-case dossiers
# 40 isolated Opus-4.8 subagents -> work/pair/pred-01..40.json
node work/fix-json2.mjs                     # escape stray control chars in 4 outputs
node work/sanitize-evidence.mjs             # drop non-verbatim evidence on non-required labels
node work/assemble-pair.mjs                 # -> submission/pair-qualification-predictions.jsonl
node semantic-conflict-pair-judgment-v0.1/validate-submission.mjs \
  semantic-conflict-pair-judgment-v0.1/inputs.jsonl \
  submission/pair-qualification-predictions.jsonl \
  submission/pair-qualification-run.json
```

## Test 2 — End-to-End Radar Arena (2 episodes)

1. `work/analyze-episodes.mjs` parsed each 40-PR episode, considered all 780 pairs, and kept only **same-module** pairs (files carry a `modules/m-*` prefix; different modules are isolated by construction). Exactly **20 same-module candidate pairs** surfaced per episode; each was scored by shared-file + changed-symbol + def↔call overlap and written into a candidate dossier (`work/e2e/episode-0X-candidates.md`) plus a canonical pair list (`-top.json`).
2. One Opus-4.8 subagent per episode read `TASK_PROMPT.txt` (unchanged) + the candidate dossier and ranked all 20 candidate pairs by pair-induced-conflict likelihood, emitting decision/confidence/explanation (`work/e2e/episode-0X-ranked.json`).
3. `work/assemble-e2e.mjs` mapped the ranking onto the canonical pair set (guaranteeing exactly 20 distinct valid pairs, contiguous ranks 1–20) → `submission/radar-arena-predictions.jsonl`.
4. Validator passed: `Submission valid: 2 episodes, 40 ranked pairs.`
- Episode-01 decisions: conflict 7, review 6, independent 5, coordination 2.
- Episode-02 decisions: conflict 5, review 9, independent 5, coordination 1.

### Actual commands (Test 2)
```bash
node work/analyze-episodes.mjs              # candidate dossiers (20 same-module pairs/episode)
# 2 Opus-4.8 subagents -> work/e2e/episode-0X-ranked.json
node work/assemble-e2e.mjs                  # -> submission/radar-arena-predictions.jsonl
node semantic-conflict-end-to-end-v0.1/validate-submission.mjs \
  semantic-conflict-end-to-end-v0.1/episodes \
  submission/radar-arena-predictions.jsonl \
  submission/radar-arena-run.json
```

## Timing

- Test 1: startedAt/finishedAt and `totalLatencyMs` in `pair-qualification-run.json` are the batch wall-clock span of prediction-file write times across concurrency-capped waves.
- Test 2: `totalLatencyMs` / `episodeRuns[].latencyMs` in `radar-arena-run.json` are the ranking-agent wall-clock span.
- These are real measured wall-clock spans, not estimates.

## Tokens / cost

- Recorded as `null` in both run files. Per-subagent token counts were emitted by the harness but the run wrapper did not aggregate a trustworthy total, so per the rules the unmeasured aggregate is `null` rather than estimated.

## Failures / repairs

- Failed cases/episodes: **0** (every judgment produced output on first run).
- Post-hoc **format-only** fixes (no re-judging, no prompt/rule tuning, no gold consulted):
  - 4 Test-1 outputs contained a raw tab/newline inside a JSON string (copied verbatim from a patch); `fix-json2.mjs` escaped the control characters so the JSON parses. Quote contents were preserved, so verbatim matching is unaffected.
  - 1 Test-1 case (`independent`) had one evidence quote that was not a verbatim substring of its side; since evidence is optional for `independent`, `sanitize-evidence.mjs` dropped only that one item. Evidence required for conflict/review/coordination was never dropped.

## Environment variables

- `GITHUB_TOKEN` was **not** required or used (no network access; all inputs came from the supplied files). No secrets recorded.

## Constraint compliance

- No gold labels, fixing commits, prior predictions, web search, or repository checkout were used.
- Fixed prompts and input files were not modified (SHA-256 verified by both validators).
- No test-time tuning: outputs were not regenerated after inspecting any score (no scores are available to us; gold is held by the evaluator).
