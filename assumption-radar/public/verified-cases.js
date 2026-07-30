import { verifiedRepoContexts } from "./verified-repo-context.js";

export const verifiedCases = {
  zeppelin: {
    repository: "apache/zeppelin · Case #1",
    generatedAt: "2026-07-19T07:34:25.544Z",
    mode: "verified-case",
    preflight: { complete: true },
    categories: { "api-contract": "Cross-language API contract" },
    summary: {
      prCount: 2,
      pairCount: 1,
      candidateCount: 1,
      aiReviewedPairCount: 1,
      conflictCount: 1,
      coordinationCount: 0,
      reviewCount: 0,
      independentCount: 0,
      insufficientCount: 0,
    },
    prs: [
      {
        id: "5277",
        number: 5277,
        title: "Add MCP server for operating notebooks from AI agents",
        author: "Apache Zeppelin contributor",
        url: "https://github.com/apache/zeppelin/pull/5277",
        paths: [
          "zeppelin-mcp/src/zeppelin_mcp/client.py",
          "zeppelin-mcp/src/zeppelin_mcp/server.py",
        ],
        assumptions: [
          {
            type: "client contract",
            text: "Omitting noteId from the existing restart endpoint performs a global interpreter restart.",
            anchor: "ZeppelinClient.restart_interpreter",
          },
        ],
      },
      {
        id: "5151",
        number: 5151,
        title: "Separate restart all interpreters into a dedicated endpoint",
        author: "Apache Zeppelin contributor",
        url: "https://github.com/apache/zeppelin/pull/5151",
        paths: [
          "zeppelin-server/src/main/java/org/apache/zeppelin/rest/InterpreterRestApi.java",
          "docs/usage/rest_api/interpreter.md",
        ],
        assumptions: [
          {
            type: "server contract",
            text: "The existing restart endpoint is note-scoped and must reject requests without noteId.",
            anchor: "InterpreterRestApi.restartSetting",
          },
        ],
      },
    ],
    findings: [
      {
        id: "zeppelin-5277x5151",
        prIds: ["5277", "5151"],
        verdict: "conflict",
        category: "api-contract",
        basis: "cross-language-contract",
        source: "AI hypothesis + contract replay",
        title: "The MCP client calls the wrong restart endpoint after the server contract changes",
        summary: "The Python MCP client keeps using the original restart endpoint for both note-scoped and global restarts. The Java server change splits global restart into a new endpoint and makes noteId mandatory on the original path.",
        assumptionA: "A missing noteId means “restart globally” on PUT /interpreter/setting/restart/{settingId}.",
        assumptionB: "PUT /interpreter/setting/restart/{settingId} requires noteId; global restart must use /restart-all/{settingId}.",
        consequence: "The MCP tool's default global restart request is rejected with HTTP 400 instead of restarting the interpreter.",
        recommendation: "Route note-scoped calls to /restart with noteId, route global calls to /restart-all, and add a client-server contract test for both paths.",
        retrievalFeatures: {
          sharedFiles: [
            "contract:/interpreter/setting/restart/{settingId}",
            "contract:/interpreter/setting/restart-all/{settingId}",
          ],
        },
        evidence: [
          {
            id: "Z-A1",
            side: "A",
            file: "zeppelin-mcp/src/zeppelin_mcp/client.py",
            symbol: "ZeppelinClient.restart_interpreter",
            quote: "payload = {\"noteId\": note_id} if note_id else None; self._request(\"PUT\", f\"/interpreter/setting/restart/{setting_id}\", json=payload)",
          },
          {
            id: "Z-B1",
            side: "B",
            file: "zeppelin-server/src/main/java/org/apache/zeppelin/rest/InterpreterRestApi.java",
            symbol: "restartSetting",
            quote: "if (null == noteId) { return new JsonResponse<>(Status.BAD_REQUEST, \"noteId is required. Use /restart-all endpoint for global restart.\").build(); }",
          },
          {
            id: "Z-B2",
            side: "B",
            file: "zeppelin-server/src/main/java/org/apache/zeppelin/rest/InterpreterRestApi.java",
            symbol: "restartSettingAll",
            quote: "@PUT @Path(\"setting/restart-all/{settingId}\") public Response restartSettingAll(...)",
          },
        ],
        witnesses: [
          {
            title: "Client-server contract mismatch",
            explanation: "The same user action is mapped to the old path by the Python client and to the new restart-all path by the Java server.",
            strength: "bilateral code evidence",
          },
        ],
        verification: {
          states: {
            git_merge: "clean",
            client_test_suite: "61 passed",
            combined_client_suite: "61 passed",
            combined_global_restart: "HTTP 400 in contract replay",
            combined_note_restart: "pass",
          },
        },
      },
    ],
  },

  mypy: {
    repository: "python/mypy · Case #2",
    generatedAt: "2026-07-28T00:00:00.000Z",
    mode: "verified-case",
    preflight: { complete: true },
    categories: { "diagnostic-contract": "Diagnostic behavior contract" },
    summary: {
      prCount: 2,
      pairCount: 1,
      candidateCount: 1,
      aiReviewedPairCount: 1,
      conflictCount: 1,
      coordinationCount: 0,
      reviewCount: 0,
      independentCount: 0,
      insufficientCount: 0,
    },
    prs: [
      {
        id: "21562",
        number: 21562,
        title: "Fix crashing on invalid Concatenate usage",
        author: "themylogin",
        url: "https://github.com/python/mypy/pull/21562",
        paths: [
          "mypy/typeanal.py",
          "test-data/unit/check-parameter-specification.test",
        ],
        assumptions: [
          {
            type: "diagnostic contract",
            text: "A misplaced Concatenate in a Callable argument reaches the recovery path with one exact diagnostic.",
            anchor: "testParamSpecNoCrashOnConcatenateInCallableArg",
          },
        ],
      },
      {
        id: "21531",
        number: 21531,
        title: "Update Concatenate tuple test expectation",
        author: "Deepak kudi",
        url: "https://github.com/python/mypy/pull/21531",
        paths: [
          "mypy/typeanal.py",
          "test-data/unit/check-parameter-specification.test",
        ],
        assumptions: [
          {
            type: "validation contract",
            text: "Misplaced Concatenate is rejected earlier with a general location error and explanatory note.",
            anchor: "TypeAnalyser.anal_type",
          },
        ],
      },
    ],
    findings: [
      {
        id: "mypy-21562x21531",
        prIds: ["21562", "21531"],
        verdict: "conflict",
        category: "diagnostic-contract",
        basis: "combined-execution",
        source: "Base/A/B/A+B replay",
        title: "An earlier validation path bypasses the diagnostic expected by the other PR",
        summary: "One PR adds a targeted recovery diagnostic for invalid Concatenate usage. The other rejects the same input earlier with a different error and note, so the combined implementation no longer satisfies the new test contract.",
        assumptionA: "The invalid Callable argument produces “Concatenate is only valid as the first argument to Callable”.",
        assumptionB: "The same input is rejected earlier as “Invalid location for Concatenate” with an additional note.",
        consequence: "The combined tree fails testParamSpecNoCrashOnConcatenateInCallableArg because the observed diagnostic no longer matches the expected one.",
        recommendation: "Choose one canonical diagnostic path and update the implementation and regression test together before merging either ordering.",
        retrievalFeatures: {
          sharedFiles: [
            "mypy/typeanal.py",
            "test-data/unit/check-parameter-specification.test",
          ],
        },
        evidence: [
          {
            id: "M-A1",
            side: "A",
            file: "test-data/unit/check-parameter-specification.test",
            symbol: "testParamSpecNoCrashOnConcatenateInCallableArg",
            line: 2771,
            quote: "def run(callback: Callable[[Concatenate[int, ...]], None]) -> None:  # E: Concatenate is only valid as the first argument to Callable",
          },
          {
            id: "M-B1",
            side: "B",
            file: "mypy/typeanal.py",
            symbol: "TypeAnalyser.anal_type",
            line: 499,
            quote: "self.fail(\"Invalid location for Concatenate\", t, code=codes.VALID_TYPE); self.note(\"You can use Concatenate as the first argument to Callable\", t)",
          },
        ],
        witnesses: [
          {
            title: "Competing diagnostic paths",
            explanation: "Both changes handle the same invalid type expression, but they define different observable error output.",
            strength: "code + test evidence",
          },
        ],
        verification: {
          states: {
            base: "116 passed",
            pr_21562: "117 passed",
            pr_21531: "116 passed",
            combined_run_1: "116 passed, 1 failed",
            combined_run_2: "same failure",
            combined_reverse_order: "same failure",
          },
        },
      },
    ],
  },
};

function pairKey(prIds) {
  return [...prIds].map(String).sort().join(":");
}

function reviewFamily(finding) {
  if (/added twice/i.test(finding.title)) return "duplicate-addition";
  if (/old \d+-argument call/i.test(finding.title)) return "signature-callsite";
  return finding.category || "other";
}

function reviewStrength(finding) {
  const genericSymbolPenalty = /\b(?:isinstance|reveal_type|get|case|print|fail|f|a|c)\b/i.test(finding.title) ? 3 : 0;
  return (finding.witnesses?.length || 0) * 2 - genericSymbolPenalty;
}

function representativeReviewCandidates(findings, limit = 5) {
  const grouped = new Map();
  for (const finding of findings) {
    const key = reviewFamily(finding);
    grouped.set(key, [...(grouped.get(key) || []), finding]);
  }
  const families = [...grouped.values()]
    .map((items) => items.sort((a, b) => reviewStrength(b) - reviewStrength(a) || a.id.localeCompare(b.id)));
  const selected = [];
  for (let index = 0; selected.length < limit && families.some((items) => items[index]); index += 1) {
    for (const items of families) {
      if (items[index]) selected.push(items[index]);
      if (selected.length === limit) break;
    }
  }
  return selected;
}

function hydrateWithLiveRepository(caseKey, label) {
  const demoCase = verifiedCases[caseKey];
  const context = verifiedRepoContexts[caseKey];
  const curatedPrs = new Map(demoCase.prs.map((pr) => [pr.id, pr]));
  const curatedPairKeys = new Set(demoCase.findings.map((finding) => pairKey(finding.prIds)));
  demoCase.prs = context.prs.map((pr) => {
    const curated = curatedPrs.get(pr.id);
    if (!curated) return pr;
    return {
      ...pr,
      ...curated,
      paths: [...new Set([...(pr.paths || []), ...(curated.paths || [])])],
    };
  });
  for (const [id, pr] of curatedPrs) {
    if (!demoCase.prs.some((item) => item.id === id)) demoCase.prs.push(pr);
  }
  const unverifiedReviews = context.findings.filter((finding) =>
    finding.verdict === "review" && !curatedPairKeys.has(pairKey(finding.prIds)));
  demoCase.findings.push(...representativeReviewCandidates(unverifiedReviews));
  demoCase.repository = `${label} · ${demoCase.prs.length} open PRs · ${caseKey === "zeppelin" ? "Case #1" : "Case #2"}`;
  demoCase.generatedAt = context.generatedAt;
  demoCase.categories.rollout = "Git merge coordination";
  demoCase.categories.code = "Static interaction candidate";
  demoCase.summary = {
    ...context.summary,
    prCount: demoCase.prs.length,
    conflictCount: demoCase.findings.filter((finding) => finding.verdict === "conflict").length,
    coordinationCount: 0,
    reviewCount: demoCase.findings.filter((finding) => finding.verdict === "review").length,
    aiReviewedPairCount: 1,
  };
}

hydrateWithLiveRepository("zeppelin", "apache/zeppelin");
hydrateWithLiveRepository("mypy", "python/mypy");
