#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const LABELS = new Set(["conflict", "review", "independent", "insufficient", "coordination"]);
const EVIDENCE_REQUIRED = new Set(["conflict", "review", "coordination"]);

function containsQuote(value, quote) {
  if (typeof value === "string") return value.includes(quote);
  if (Array.isArray(value)) return value.some((item) => containsQuote(item, quote));
  if (value && typeof value === "object") return Object.values(value).some((item) => containsQuote(item, quote));
  return false;
}

async function readJsonl(path) {
  const text = await readFile(path, "utf8");
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${path}:${index + 1}: invalid JSON (${error.message})`);
    }
  });
}

function requiredString(record, field, line, errors, allowEmpty = false) {
  if (typeof record[field] !== "string" || (!allowEmpty && !record[field].trim())) {
    errors.push(`prediction line ${line}: ${field} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
}

function validatePrediction(record, input, line, errors) {
  if (record.schemaVersion !== "pair-qualification-prediction-v0.1") {
    errors.push(`prediction line ${line}: invalid schemaVersion`);
  }
  if (record.id !== input.id) errors.push(`prediction line ${line}: id/order mismatch (expected '${input.id}')`);
  if (!LABELS.has(record.prediction)) errors.push(`prediction line ${line}: invalid prediction '${record.prediction}'`);
  if (!Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
    errors.push(`prediction line ${line}: confidence must be between 0 and 1`);
  }
  requiredString(record, "assumptionA", line, errors, true);
  requiredString(record, "assumptionB", line, errors, true);
  requiredString(record, "failureMechanism", line, errors, true);
  requiredString(record, "explanation", line, errors);

  if (!Array.isArray(record.evidence)) {
    errors.push(`prediction line ${line}: evidence must be an array`);
    return;
  }

  const sides = new Set();
  record.evidence.forEach((item, evidenceIndex) => {
    const prefix = `prediction line ${line}, evidence ${evidenceIndex + 1}`;
    if (!item || typeof item !== "object") {
      errors.push(`${prefix}: must be an object`);
      return;
    }
    if (item.side !== "A" && item.side !== "B") {
      errors.push(`${prefix}: side must be A or B`);
      return;
    }
    sides.add(item.side);
    for (const field of ["file", "symbol", "quote"]) {
      if (typeof item[field] !== "string") errors.push(`${prefix}: ${field} must be a string`);
    }
    if (typeof item.quote === "string" && item.quote) {
      const pr = input.prs?.[item.side === "A" ? 0 : 1];
      if (!pr || !containsQuote(pr, item.quote)) {
        errors.push(`${prefix}: quote does not occur verbatim in side ${item.side}`);
      }
    } else {
      errors.push(`${prefix}: quote must not be empty`);
    }
  });

  if (EVIDENCE_REQUIRED.has(record.prediction) && (!sides.has("A") || !sides.has("B"))) {
    errors.push(`prediction line ${line}: ${record.prediction} requires evidence from both A and B`);
  }
}

function validateRun(run, expectedPromptHash, errors) {
  const requiredStrings = ["systemName", "version", "model", "startedAt", "finishedAt"];
  if (run.schemaVersion !== "pair-qualification-run-v0.1") errors.push("run.json: invalid schemaVersion");
  for (const field of requiredStrings) {
    if (typeof run[field] !== "string" || !run[field].trim()) errors.push(`run.json: ${field} is required`);
  }
  if (run.promptSha256 !== expectedPromptHash) {
    errors.push(`run.json: promptSha256 mismatch (expected ${expectedPromptHash})`);
  }
  if (!Number.isFinite(run.totalLatencyMs) || run.totalLatencyMs < 0) errors.push("run.json: totalLatencyMs must be non-negative");
  if (!Number.isInteger(run.failedCases) || run.failedCases < 0) errors.push("run.json: failedCases must be a non-negative integer");
}

async function main() {
  const [inputsPath = "inputs.jsonl", predictionsPath = "pair-qualification-predictions.jsonl", runPath = "pair-qualification-run.json"] = process.argv.slice(2);
  const [inputs, predictions, runText, systemPrompt, userPrompt] = await Promise.all([
    readJsonl(inputsPath),
    readJsonl(predictionsPath),
    readFile(runPath, "utf8"),
    readFile(new URL("./SYSTEM_PROMPT.txt", import.meta.url), "utf8"),
    readFile(new URL("./USER_PROMPT_TEMPLATE.txt", import.meta.url), "utf8"),
  ]);

  const run = JSON.parse(runText);
  const errors = [];
  if (predictions.length !== inputs.length) {
    errors.push(`prediction count mismatch: expected ${inputs.length}, got ${predictions.length}`);
  }

  const ids = new Set();
  predictions.forEach((record, index) => {
    if (ids.has(record.id)) errors.push(`prediction line ${index + 1}: duplicate id '${record.id}'`);
    ids.add(record.id);
    if (inputs[index]) validatePrediction(record, inputs[index], index + 1, errors);
  });

  const promptHash = createHash("sha256").update(systemPrompt).update("\n---USER---\n").update(userPrompt).digest("hex");
  validateRun(run, promptHash, errors);

  if (errors.length) throw new Error(errors.slice(0, 50).join("\n"));
  console.log(`Submission valid: ${predictions.length} predictions, ${ids.size} unique input cases.`);
  console.log(`Prompt SHA-256: ${promptHash}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
