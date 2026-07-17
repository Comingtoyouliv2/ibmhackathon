import crypto from "node:crypto";

export const SCIR_SCHEMA_VERSION = "ar-scs-0.1";
export const PROOF_GRADES = Object.freeze(["proximity", "structural", "resolved", "executable"]);
export const OPERATION_KINDS = Object.freeze(["add", "remove", "rename", "move", "change-signature", "change-type", "change-default", "change-visibility", "change-behavior"]);
export const DEPENDENCY_RELATIONS = Object.freeze(["calls", "imports", "references", "reads", "writes", "extends", "implements", "produces", "consumes", "serializes", "configures", "asserts", "requires-binding"]);

const uniqueById = (records) => [...new Map(records.map((record) => [record.id, record])).values()];

export function stableId(prefix, ...parts) {
  const digest = crypto.createHash("sha256").update(parts.map((part) => JSON.stringify(part ?? null)).join("\u0000")).digest("hex").slice(0, 16);
  return `${prefix}:${digest}`;
}

export function createEvidence({ changeSetId, adapterId, kind = "diff", grade = "structural", path, line = null, summary, excerpt = "", metadata = {} }) {
  return {
    id: stableId("evidence", changeSetId, adapterId, kind, path, line, summary, excerpt),
    kind, grade, path, line, summary, excerpt, metadata: { adapterId, ...metadata },
  };
}

export function createEntity({ adapterId, kind, name, scope, language = "unknown", identityStatus = "provisional", metadata = {} }) {
  return {
    id: stableId("entity", adapterId, language, kind, scope, name),
    kind, name, scope, language, identityStatus, metadata: { adapterId, ...metadata },
  };
}

export function createOperation({ adapterId, kind, entityId, before = null, after = null, evidenceIds, proofGrade = "structural", metadata = {} }) {
  return {
    id: stableId("operation", adapterId, kind, entityId, before, after, metadata),
    kind, entityId, before, after, evidenceIds: [...new Set(evidenceIds)], proofGrade,
    metadata: { adapterId, ...metadata },
  };
}

export function createDependency({ adapterId, relation, sourceEntityId = null, target, status = "added", evidenceIds, proofGrade = "structural", metadata = {} }) {
  return {
    id: stableId("dependency", adapterId, relation, sourceEntityId, target, status, metadata),
    relation, sourceEntityId, target, status, evidenceIds: [...new Set(evidenceIds)], proofGrade,
    metadata: { adapterId, ...metadata },
  };
}

export function createAssumption({ adapterId, kind, target, evidenceIds, proofGrade = "structural", metadata = {} }) {
  return {
    id: stableId("assumption", adapterId, kind, target, metadata),
    kind, target, evidenceIds: [...new Set(evidenceIds)], proofGrade, metadata: { adapterId, ...metadata },
  };
}

export function createChangeSet({ changeSetId, fragments }) {
  return {
    schemaVersion: SCIR_SCHEMA_VERSION,
    changeSetId,
    adapters: [...new Set(fragments.map((fragment) => fragment.adapterId))],
    languages: [...new Set(fragments.map((fragment) => fragment.language).filter(Boolean))],
    entities: uniqueById(fragments.flatMap((fragment) => fragment.entities || [])),
    operations: uniqueById(fragments.flatMap((fragment) => fragment.operations || [])),
    dependencies: uniqueById(fragments.flatMap((fragment) => fragment.dependencies || [])),
    assumptions: uniqueById(fragments.flatMap((fragment) => fragment.assumptions || [])),
    evidence: uniqueById(fragments.flatMap((fragment) => fragment.evidence || [])),
  };
}

export function validateChangeSet(changeSet) {
  const errors = [];
  if (changeSet?.schemaVersion !== SCIR_SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCIR_SCHEMA_VERSION}`);
  if (!changeSet?.changeSetId) errors.push("changeSetId is required");
  for (const key of ["adapters", "languages", "entities", "operations", "dependencies", "assumptions", "evidence"]) {
    if (!Array.isArray(changeSet?.[key])) errors.push(`${key} must be an array`);
  }
  if (errors.length) return { valid: false, errors };
  const evidenceIds = new Set(changeSet.evidence.map((item) => item.id));
  const entityIds = new Set(changeSet.entities.map((item) => item.id));
  const duplicateIds = (records) => records.length !== new Set(records.map((item) => item.id)).size;
  for (const [key, records] of Object.entries({ entities: changeSet.entities, operations: changeSet.operations, dependencies: changeSet.dependencies, assumptions: changeSet.assumptions, evidence: changeSet.evidence })) {
    if (duplicateIds(records)) errors.push(`${key} contains duplicate ids`);
  }
  for (const operation of changeSet.operations) {
    if (!OPERATION_KINDS.includes(operation.kind)) errors.push(`unknown operation kind ${operation.kind}`);
    if (!entityIds.has(operation.entityId)) errors.push(`operation ${operation.id} references missing entity ${operation.entityId}`);
    if (!PROOF_GRADES.includes(operation.proofGrade)) errors.push(`operation ${operation.id} has invalid proof grade`);
    if (!operation.evidenceIds?.length || operation.evidenceIds.some((id) => !evidenceIds.has(id))) errors.push(`operation ${operation.id} has invalid evidence refs`);
  }
  for (const dependency of changeSet.dependencies) {
    if (!DEPENDENCY_RELATIONS.includes(dependency.relation)) errors.push(`unknown dependency relation ${dependency.relation}`);
    if (!PROOF_GRADES.includes(dependency.proofGrade)) errors.push(`dependency ${dependency.id} has invalid proof grade`);
    if (!dependency.evidenceIds?.length || dependency.evidenceIds.some((id) => !evidenceIds.has(id))) errors.push(`dependency ${dependency.id} has invalid evidence refs`);
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidChangeSet(changeSet) {
  const validation = validateChangeSet(changeSet);
  if (!validation.valid) throw new Error(`Invalid SCIR change set:\n- ${validation.errors.join("\n- ")}`);
  return changeSet;
}
