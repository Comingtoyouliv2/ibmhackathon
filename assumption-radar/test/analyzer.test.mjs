import test from "node:test";
import assert from "node:assert/strict";
import { analyzeHeuristically, assessCausalProof, createAnalyzer, createWitness, extractSignals, prepareAnalysis, finishAnalysis } from "../src/analyzer.mjs";

const pr = (id, files, extra = {}) => ({ id, number: Number(id.replace(/\D/g, "")) || 1, title: `PR ${id}`, files, ...extra });
const file = (filename, patch, status = "modified") => ({ filename, status, patch });

test("the change model extracts directional contract evidence", () => {
  const model = extractSignals(pr("1", [file("migrations/rename.sql", "@@ -0,0 +1,2 @@\n+ALTER TABLE orders RENAME COLUMN total_amount TO amount_cents;\n+SELECT amount_cents FROM orders") ]));
  assert.deepEqual(model.renames.map(({ from, to }) => ({ from, to })), [{ from: "total_amount", to: "amount_cents" }]);
  assert.ok(model.added.tables.includes("orders"));
});

test("same file in separate declarations is proximity, not a finding", () => {
  const result = analyzeHeuristically([
    pr("1", [file("src/Service.java", "@@ -10,1 +10,1 @@ public void alpha()\n-oldA();\n+newA();")]),
    pr("2", [file("src/Service.java", "@@ -80,1 +80,1 @@ public void beta()\n-oldB();\n+newB();")]),
  ]);
  assert.equal(result.findings.length, 0);
  assert.equal(result.summary.independentCount, 1);
  assert.equal(result.summary.noAlertUnreviewedCount, 1);
  assert.equal(result.summary.aiReviewedPairCount, 0);
});

test("prose in a hunk section is not parsed as a code declaration", () => {
  const result = analyzeHeuristically([
    pr("1", [file("model.py", "@@ -10,1 +10,1 @@ class of problems.\n-old documentation\n+new documentation")]),
    pr("2", [file("model.py", "@@ -80,1 +80,1 @@ class of problems.\n-old note\n+new note")]),
  ]);
  assert.equal(result.findings.length, 0);
  assert.equal(result.summary.independentCount, 1);
});

test("line coordinates from different base SHAs are not compared", () => {
  const result = analyzeHeuristically([
    pr("1", [file("model.py", "@@ -10,0 +11,1 @@\n+first_change = True")], { baseSha: "base-a" }),
    pr("2", [file("model.py", "@@ -10,0 +11,1 @@\n+second_change = True")], { baseSha: "base-b" }),
  ]);
  assert.equal(result.findings.length, 0);
  assert.equal(result.summary.independentCount, 1);
});

test("different replacements of the same base line are routed to semantic review", () => {
  const result = analyzeHeuristically([
    pr("1", [file("src/Price.java", "@@ -10,1 +10,1 @@ public Money total()\n-return subtotal;\n+return subtotal.plus(tax);")]),
    pr("2", [file("src/Price.java", "@@ -10,1 +10,1 @@ public Money total()\n-return subtotal;\n+return discountedSubtotal;")]),
  ]);
  assert.equal(result.findings[0].verdict, "review");
  assert.equal(result.findings[0].basis, "causal-witness");
  assert.ok(result.findings[0].witnesses.some((item) => item.type === "competing-replacement"));
  assert.equal(result.findings[0].causalAnalysis.status, "supported-interaction");
});

test("same declaration alone is relevance, not causal proof", () => {
  const prepared = prepareAnalysis([
    pr("1", [file("solver.py", "@@ -10,1 +10,2 @@ def solve(kind):\n old_backend()\n+if kind in ('safe',): use_array_api()")]),
    pr("2", [file("solver.py", "@@ -30,1 +30,2 @@ def solve(kind):\n fallback_backend()\n+if kind == 'newton-cd': use_numpy()")]),
  ]);
  assert.equal(prepared.comparisons[0].verdict, "independent");
  assert.equal(prepared.comparisons[0].basis, "relevance-only");
  assert.equal(prepared.comparisons[0].causalAnalysis.status, "hypothesis-only");
  assert.deepEqual(prepared.comparisons[0].causalAnalysis.proofWitnessTypes, []);
  assert.ok(prepared.comparisons[0].causalAnalysis.relevanceWitnessTypes.includes("same-declaration"));
});

test("causal proof roles separate contract contradictions from relevance", () => {
  const assessment = assessCausalProof([
    createWitness("same-declaration", "semantic", "code", "same", "related", ["f.py", "solve"]),
    createWitness("contract-removal-vs-use", "direct", "api", "removed", "broken", ["/v1/pay"]),
  ]);
  assert.equal(assessment.status, "contradiction");
  assert.deepEqual(assessment.proofWitnessTypes, ["contract-removal-vs-use"]);
  assert.deepEqual(assessment.relevanceWitnessTypes, ["same-declaration"]);
});

test("the same removed public signature replaced in two ways is a conflict", () => {
  const result = analyzeHeuristically([
    pr("1", [file("Api.java", "@@ -1,1 +1,1 @@\n-public Result load(String id) {\n+public Result load(UUID id) {")]),
    pr("2", [file("Api.java", "@@ -1,1 +1,1 @@\n-public Result load(String id) {\n+public Promise<Result> load(String id) {")]),
  ]);
  assert.equal(result.findings[0].verdict, "conflict");
  assert.ok(result.findings[0].witnesses.some((item) => item.type === "signature-divergence"));
});

test("a multiline signature change conflicts with a newly added old-arity call", () => {
  const result = analyzeHeuristically([
    pr("1", [file("ContextImpl.java", "@@ -10,3 +10,4 @@\n public void init(\n     Request request,\n+    ServletContext servletContext,\n     Response response) {")]),
    pr("2", [file("Filter.java", "@@ -20,0 +21,2 @@\n+ContextImpl context = new ContextImpl();\n+context.init(request, response);")]),
  ]);
  assert.equal(result.findings[0].verdict, "conflict");
  assert.ok(result.findings[0].witnesses.some((item) => item.type === "signature-change-vs-old-call"));
});

test("unqualified Builder names in different files do not create a direct signature conflict", () => {
  const result = analyzeHeuristically([
    pr("1", [file("ShardProfile.java", "@@ -10,1 +10,1 @@\n-public Builder(String shard) {\n+public Builder() {")]),
    pr("2", [file("GrpcTlsConfig.java", "@@ -20,0 +21,1 @@\n+return new Builder(\"tls\");")]),
  ]);
  assert.ok(!result.findings[0]?.witnesses.some((item) => item.type === "signature-change-vs-old-call"));
});

test("unqualified Kind names in different files do not create a removed-symbol conflict", () => {
  const result = analyzeHeuristically([
    pr("1", [file("SearchModel.java", "@@ -10,1 +10,0 @@\n-public enum Kind { QUERY }")]),
    pr("2", [file("GrpcModel.java", "@@ -20,0 +21,1 @@\n+private Kind kind;")]),
  ]);
  assert.ok(!result.findings[0]?.witnesses.some((item) => item.type === "removed-symbol-vs-new-reference"));
});

test("a moved old-arity call is not treated as a newly added call", () => {
  const result = analyzeHeuristically([
    pr("1", [file("ContextImpl.java", "@@ -10,1 +10,1 @@\n-public void init(Request request, Response response) {\n+public void init(Request request, ServletContext servletContext, Response response) {")]),
    pr("2", [file("Filter.java", "@@ -20,2 +20,2 @@\n-context.init(request, response);\n cleanup();\n+context.init(request, response);")]),
  ]);
  assert.equal(result.findings.length, 0);
  assert.equal(result.summary.independentCount, 1);
});

test("the same declaration added at different base anchors is a duplicate conflict", () => {
  const result = analyzeHeuristically([
    pr("1", [file("Registry.java", "@@ -10,0 +11,1 @@\n+public void registerPlugin() {}")]),
    pr("2", [file("Registry.java", "@@ -80,0 +81,1 @@\n+public void registerPlugin() {}")]),
  ]);
  assert.equal(result.findings[0].verdict, "conflict");
  assert.ok(result.findings[0].witnesses.some((item) => item.type === "duplicate-declaration-addition"));
});

test("duplicate constants are matched by identity despite different visibility", () => {
  const result = analyzeHeuristically([
    pr("1", [file("Runtime.java", "@@ -10,0 +11,1 @@\n+public static final String LIC_SWITCH_MODE = \"LIC_SWITCH_MODE\";")]),
    pr("2", [file("Runtime.java", "@@ -80,0 +81,1 @@\n+private static final String LIC_SWITCH_MODE = \"LIC_SWITCH_MODE\";")]),
  ]);
  assert.equal(result.findings[0].verdict, "conflict");
  assert.ok(result.findings[0].witnesses.some((item) => item.type === "duplicate-declaration-addition"));
});

test("the same insertion anchor is not reported as a clean-merge duplicate", () => {
  const result = analyzeHeuristically([
    pr("1", [file("Registry.java", "@@ -10,0 +11,1 @@\n+public void registerPlugin() {}")]),
    pr("2", [file("Registry.java", "@@ -10,0 +11,1 @@\n+public void registerPlugin() {}")]),
  ]);
  assert.ok(!result.findings[0]?.witnesses.some((item) => item.type === "duplicate-declaration-addition"));
});

test("different overload arities are not duplicate declarations", () => {
  const result = analyzeHeuristically([
    pr("1", [file("Registry.java", "@@ -10,0 +11,1 @@\n+public void registerPlugin(String name) {}")]),
    pr("2", [file("Registry.java", "@@ -80,0 +81,1 @@\n+public void registerPlugin(String name, Plugin plugin) {}")]),
  ]);
  assert.ok(!result.findings[0]?.witnesses.some((item) => item.type === "duplicate-declaration-addition"));
});

test("unchanged overloads in one hunk do not invent signature changes", () => {
  const result = analyzeHeuristically([
    pr("1", [file("Api.java", "@@ -1,6 +1,7 @@\n public void load(String id) {\n+    audit(id);\n }\n public void load(String id, int retries) {\n     fetch(id, retries);\n }")]),
    pr("2", [file("Client.java", "@@ -20,0 +21,1 @@\n+api.load(\"item\");")]),
  ]);
  assert.ok(!result.findings[0]?.witnesses.some((item) => item.type === "signature-change-vs-old-call"));
});

test("rename followed by a new old-name reference produces a conflict across files", () => {
  const result = analyzeHeuristically([
    pr("1", [file("migrations/rename.sql", "@@ -0,0 +1,1 @@\n+ALTER TABLE orders RENAME COLUMN total_amount TO amount_cents;")]),
    pr("2", [file("src/Checkout.java", "@@ -20,0 +21,1 @@\n+return order.total_amount;")]),
  ]);
  assert.equal(result.findings[0].verdict, "conflict");
  assert.ok(result.findings[0].witnesses.some((item) => item.type === "rename-vs-old-reference"));
});

test("repeated identifier substitution is inferred as rename against a new old member use", () => {
  const result = analyzeHeuristically([
    pr("1", [file("RemoteNode.java", "@@ -10,2 +10,2 @@\n-public Location location;\n-return location.hashCode();\n+public Location physicalLocation;\n+return physicalLocation.hashCode();")]),
    pr("2", [file("Session.java", "@@ -20,0 +21,1 @@\n+connections.remove(address.location);")]),
  ]);
  assert.equal(result.findings[0].verdict, "conflict");
  assert.ok(result.findings[0].witnesses.some((item) => item.type === "rename-vs-old-reference"));
});

test("one identifier replacement is not enough to infer a rename", () => {
  const result = analyzeHeuristically([
    pr("1", [file("RemoteNode.java", "@@ -10,1 +10,1 @@\n-public Location location;\n+public Location physicalLocation;")]),
    pr("2", [file("Session.java", "@@ -20,0 +21,1 @@\n+connections.remove(address.location);")]),
  ]);
  assert.equal(result.findings.length, 0);
});

test("an old-name reference moved within the other PR is not a new rename conflict", () => {
  const result = analyzeHeuristically([
    pr("1", [file("RemoteNode.java", "@@ -10,2 +10,2 @@\n-public Location location;\n-return location.hashCode();\n+public Location physicalLocation;\n+return physicalLocation.hashCode();")]),
    pr("2", [file("Session.java", "@@ -20,2 +20,2 @@\n-connections.remove(address.location);\n cleanup();\n+connections.remove(address.location);")]),
  ]);
  assert.equal(result.findings.length, 0);
});

test("repeated logger level changes are behavior edits rather than identifier renames", () => {
  const result = analyzeHeuristically([
    pr("1", [file("Indexer.java", "@@ -10,2 +10,2 @@\n-logger.info(\"start\");\n-logger.info(\"done\");\n+logger.trace(\"start\");\n+logger.trace(\"done\");")]),
    pr("2", [file("Indexer.java", "@@ -30,0 +31,1 @@\n+logger.info(\"checkpoint\");")]),
  ]);
  assert.ok(!result.findings[0]?.witnesses.some((item) => item.type === "rename-vs-old-reference"));
});

test("removed Java import conflicts with a new simple-name use in the same file", () => {
  const result = analyzeHeuristically([
    pr("1", [file("src/main/java/ninja/ContextImpl.java", "@@ -2,1 +2,0 @@\n-import javax.servlet.http.Cookie;")]),
    pr("2", [file("src/main/java/ninja/ContextImpl.java", "@@ -40,0 +41,1 @@\n+response.addCookie(new Cookie(name, null));")]),
  ]);
  assert.equal(result.findings[0].verdict, "conflict");
  assert.ok(result.findings[0].witnesses.some((item) => item.type === "import-removal-vs-new-use"));
});

test("a replacement import supplied by the using PR prevents import conflict", () => {
  const result = analyzeHeuristically([
    pr("1", [file("src/main/java/ninja/ContextImpl.java", "@@ -2,1 +2,0 @@\n-import javax.servlet.http.Cookie;")]),
    pr("2", [file("src/main/java/ninja/ContextImpl.java", "@@ -2,0 +3,2 @@\n+import jakarta.servlet.http.Cookie;\n+response.addCookie(new Cookie(name, null));")]),
  ]);
  assert.ok(!result.findings[0]?.witnesses.some((item) => item.type === "import-removal-vs-new-use"));
});

test("a fully qualified new use does not depend on the removed import", () => {
  const result = analyzeHeuristically([
    pr("1", [file("src/main/java/ninja/ContextImpl.java", "@@ -2,1 +2,0 @@\n-import javax.servlet.http.Cookie;")]),
    pr("2", [file("src/main/java/ninja/ContextImpl.java", "@@ -40,0 +41,1 @@\n+response.addCookie(new javax.servlet.http.Cookie(name, null));")]),
  ]);
  assert.ok(!result.findings[0]?.witnesses.some((item) => item.type === "import-removal-vs-new-use"));
});

test("a removed Java field conflicts with a new same-file reference", () => {
  const result = analyzeHeuristically([
    pr("1", [file("src/Index.java", "@@ -4,1 +4,0 @@\n-private static final Log logger = LogFactory.getLog(Index.class);")]),
    pr("2", [file("src/Index.java", "@@ -80,0 +81,3 @@\n+public void delete(int id) {\n+  logger.error(\"delete failed\");\n+}")]),
  ]);
  assert.equal(result.findings[0].verdict, "conflict");
  assert.ok(result.findings[0].witnesses.some((item) => item.type === "removed-symbol-vs-new-reference"));
});

test("moving an existing Java field reference is not a removal conflict", () => {
  const result = analyzeHeuristically([
    pr("1", [file("src/Index.java", "@@ -4,1 +4,0 @@\n-private static final Log logger = LogFactory.getLog(Index.class);")]),
    pr("2", [file("src/Index.java", "@@ -80,2 +80,2 @@\n-logger.error(\"delete failed\");\n cleanup();\n+logger.error(\"delete failed\");")]),
  ]);
  assert.ok(!result.findings[0]?.witnesses.some((item) => item.type === "removed-symbol-vs-new-reference"));
});

test("removing a nested Java type conflicts with a qualified-to-simple new reference", () => {
  const result = analyzeHeuristically([
    pr("1", [file("src/AbstractForm.java", "@@ -20,2 +20,0 @@\n-public static class SubmitEvent extends GwtEvent<SubmitHandler> {\n-}")]),
    pr("2", [file("src/AbstractForm.java", "@@ -90,1 +90,1 @@\n-FormPanel.SubmitEvent event = new FormPanel.SubmitEvent();\n+SubmitEvent event = new SubmitEvent();")]),
  ]);
  assert.equal(result.findings[0].verdict, "conflict");
  assert.ok(result.findings[0].witnesses.some((item) => item.type === "removed-symbol-vs-new-reference"));
});

test("a removed Java type mentioned only in a new comment is not a reference", () => {
  const result = analyzeHeuristically([
    pr("1", [file("src/AbstractForm.java", "@@ -20,2 +20,0 @@\n-public static class SubmitEvent extends GwtEvent<SubmitHandler> {\n-}")]),
    pr("2", [file("src/AbstractForm.java", "@@ -90,0 +91,1 @@\n+// SubmitEvent was removed intentionally")]),
  ]);
  assert.ok(!result.findings[0]?.witnesses.some((item) => item.type === "removed-symbol-vs-new-reference"));
});

test("a removed Java type mentioned only in a string or text block is not a reference", () => {
  const result = analyzeHeuristically([
    pr("1", [file("src/AbstractForm.java", "@@ -20,2 +20,0 @@\n-public static class SubmitEvent extends GwtEvent<SubmitHandler> {\n-}")]),
    pr("2", [file("src/AbstractForm.java", "@@ -90,0 +91,4 @@\n+logger.info(\"SubmitEvent was removed\");\n+String note = \"\"\"\n+SubmitEvent migration note\n+\"\"\";")]),
  ]);
  assert.ok(!result.findings[0]?.witnesses.some((item) => item.type === "removed-symbol-vs-new-reference"));
});

test("constructor state and a separate method behavior form a directional review dependency", () => {
  const result = analyzeHeuristically([
    pr("1", [file("src/DefaultEnvironment.java", "@@ -40,1 +40,1 @@ public DefaultEnvironment(EnvironmentType type)\n-this.type = firstNonNull(type, DEVELOPMENT);\n+this.type = firstNonNull(type, EnvironmentType.DEVELOPMENT);")]),
    pr("2", [file("src/DefaultEnvironment.java", "@@ -62,1 +62,1 @@ public boolean supports(String feature)\n-return Boolean.parseBoolean(get(feature));\n+return Boolean.parseBoolean(get(feature).trim());")]),
  ]);
  assert.equal(result.findings[0].verdict, "review");
  assert.ok(result.findings[0].witnesses.some((item) => item.type === "constructor-behavior-composition"));
});

test("separate ordinary Java methods remain a hard negative", () => {
  const result = analyzeHeuristically([
    pr("1", [file("src/DefaultEnvironment.java", "@@ -40,1 +40,1 @@ public void load()\n-oldLoad();\n+newLoad();")]),
    pr("2", [file("src/DefaultEnvironment.java", "@@ -62,1 +62,1 @@ public boolean supports(String feature)\n-return oldValue();\n+return newValue();")]),
  ]);
  assert.equal(result.findings.length, 0);
});

test("Python binding removal conflicts with a new unqualified use", () => {
  const result = analyzeHeuristically([
    pr("1", [file("service.py", "@@ -1,1 +1,0 @@\n-from legacy.cookies import Cookie")]),
    pr("2", [file("service.py", "@@ -20,0 +21,1 @@\n+response.add_cookie(Cookie(name))")]),
  ]);
  assert.equal(result.findings[0].verdict, "review");
  assert.ok(result.findings[0].witnesses.some((item) => item.type === "import-removal-vs-new-use"));
});

test("Python replacement binding prevents a removal conflict", () => {
  const result = analyzeHeuristically([
    pr("1", [file("service.py", "@@ -1,1 +1,0 @@\n-from legacy.cookies import Cookie")]),
    pr("2", [file("service.py", "@@ -1,0 +2,2 @@\n+from modern.cookies import Cookie\n+response.add_cookie(Cookie(name))")]),
  ]);
  assert.ok(!result.findings[0]?.witnesses.some((item) => item.type === "import-removal-vs-new-use"));
});

test("TypeScript named binding removal conflicts with a new use", () => {
  const result = analyzeHeuristically([
    pr("1", [file("service.ts", "@@ -1,1 +1,0 @@\n-import { Cookie } from './legacy';")]),
    pr("2", [file("service.ts", "@@ -20,0 +21,1 @@\n+response.addCookie(new Cookie(name));")]),
  ]);
  assert.equal(result.findings[0].verdict, "review");
  assert.ok(result.findings[0].witnesses.some((item) => item.type === "import-removal-vs-new-use"));
});

test("TypeScript aliased replacement binding prevents a removal conflict", () => {
  const result = analyzeHeuristically([
    pr("1", [file("service.ts", "@@ -1,1 +1,0 @@\n-import { LegacyCookie as Cookie } from './legacy';")]),
    pr("2", [file("service.ts", "@@ -1,0 +2,2 @@\n+import { ModernCookie as Cookie } from './modern';\n+response.addCookie(new Cookie(name));")]),
  ]);
  assert.ok(!result.findings[0]?.witnesses.some((item) => item.type === "import-removal-vs-new-use"));
});

test("event removal versus a new consumer produces a contract conflict", () => {
  const result = analyzeHeuristically([
    pr("1", [file("events.ts", "@@ -4,1 +4,0 @@\n-publish('payment.captured', payload);")]),
    pr("2", [file("worker.ts", "@@ -8,0 +9,1 @@\n+subscribe('payment.captured', handleReceipt);")]),
  ]);
  assert.equal(result.findings[0].verdict, "conflict");
  assert.equal(result.findings[0].category, "event");
});

test("AI can resolve a semantic review as independent but cannot erase deterministic conflicts", () => {
  const semantic = prepareAnalysis([
    pr("1", [file("src/Service.java", "@@ -10,1 +10,1 @@ public void execute()\n-legacyCall();\n+newA();")]),
    pr("2", [file("src/Service.java", "@@ -10,1 +10,1 @@ public void execute()\n-legacyCall();\n+newB();")]),
  ]);
  assert.equal(semantic.comparisons[0].verdict, "review");
  const ai = [{ ...semantic.comparisons[0], verdict: "independent", basis: "ai-semantic-judgment", source: "ai" }];
  assert.equal(finishAnalysis(semantic, ai).findings.length, 0);

  const deterministic = prepareAnalysis([
    pr("3", [file("rename.sql", "@@ -0,0 +1,1 @@\n+ALTER TABLE users RENAME COLUMN full_name TO display_name;")]),
    pr("4", [file("profile.js", "@@ -0,0 +1,1 @@\n+render(user.full_name);")]),
  ]);
  const attemptedOverride = [{ ...deterministic.comparisons[0], verdict: "independent", basis: "ai-semantic-judgment", source: "ai" }];
  assert.equal(finishAnalysis(deterministic, attemptedOverride).findings[0].verdict, "conflict");
});

test("missing patches are reported as insufficient evidence", () => {
  const result = prepareAnalysis([
    pr("1", [{ filename: "asset.bin", status: "modified", patch: "" }]),
    pr("2", [{ filename: "asset.bin", status: "modified", patch: "" }]),
  ]);
  assert.equal(result.comparisons[0].verdict, "insufficient");
});

test("repositories can add domain detectors without changing global thresholds", () => {
  const terraformDetector = {
    id: "terraform-resource-address",
    detect: (a, b) => a.files.some((item) => item.filename.endsWith(".tf")) && b.files.some((item) => item.filename.endsWith(".tf"))
      ? [createWitness("terraform-address-move", "direct", "rollout", "Terraform resource address가 갈라짐", "저장소 전용 detector가 같은 resource lifecycle의 모순을 확인했습니다.", ["aws_instance.api"])]
      : [],
  };
  const analyzer = createAnalyzer({ additionalDetectors: [terraformDetector] });
  const result = analyzer.analyze([
    pr("1", [file("infra/main.tf", "@@ -1,0 +1,1 @@\n+resource \"aws_instance\" \"api\" {}")]),
    pr("2", [file("infra/other.tf", "@@ -1,0 +1,1 @@\n+moved { from = aws_instance.api }")]),
  ]);
  assert.equal(result.findings[0].verdict, "conflict");
  assert.equal(result.findings[0].witnesses[0].type, "terraform-address-move");
});
