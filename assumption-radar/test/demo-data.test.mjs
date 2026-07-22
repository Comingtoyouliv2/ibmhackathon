import assert from "node:assert/strict";
import test from "node:test";
import { adaptBackendResponse, parseRepositoryInput } from "../public/demo-data.js";

test("repository input accepts GitHub URL, clone command, SSH, and owner/repo", () => {
  assert.equal(parseRepositoryInput("https://github.com/openai/codex.git"), "openai/codex");
  assert.equal(parseRepositoryInput("git clone https://github.com/openai/codex.git"), "openai/codex");
  assert.equal(parseRepositoryInput("git@github.com:openai/codex.git"), "openai/codex");
  assert.equal(parseRepositoryInput("openai/codex"), "openai/codex");
  assert.throws(() => parseRepositoryInput("codex"), /owner\/repo/);
  assert.throws(() => parseRepositoryInput("https://gitlab.com/openai/codex"), /GitHub/);
});

test("backend adapter preserves verdicts and derives graph resources without frontend scores", () => {
  const model = adaptBackendResponse({
    repository: "example/repo",
    mode: "ai+heuristic",
    summary: { prCount: 2, pairCount: 1, candidateCount: 1, conflictCount: 1 },
    categories: { api: "API contract" },
    prs: [
      { id: "a", number: 1, title: "Change API", paths: ["src/api.js"], assumptions: ["caller migrates"] },
      { id: "b", number: 2, title: "Add caller", paths: ["src/api.js"] },
    ],
    findings: [{
      id: "a:b",
      prIds: ["a", "b"],
      verdict: "conflict",
      category: "api",
      title: "Old call meets new API",
      assumptionA: "All callers migrate",
      assumptionB: "Old signature remains",
      consequence: "Runtime failure",
      recommendation: "Update PR B",
      evidence: ["src/api.js:42"],
      basis: "deterministic",
    }],
  });

  assert.equal(model.findings[0].verdict, "conflict");
  assert.equal(model.findings[0].categoryLabel, "API contract");
  assert.equal(model.resources[0].path, "src/api.js");
  assert.equal("score" in model.findings[0], false);
  assert.equal(model.summary.pairCount, 1);
});
