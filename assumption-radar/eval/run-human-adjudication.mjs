#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHumanAnswerTemplate, resolveHumanAnswers } from "./improvement-lifecycle.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (flag, fallback = null) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : fallback; };
const has = (flag) => args.includes(flag);
const readJsonl = async (path) => (await readFile(path, "utf8")).split("\n").map((line) => line.trim()).filter(Boolean).map(JSON.parse);
const jsonl = (rows) => rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";

async function latest(root) {
  const names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  if (!names.length) throw new Error(`no harness runs in ${root}`);
  return join(root, names[0]);
}

async function interactiveAnswers(template) {
  const rl = createInterface({ input, output });
  const answers = [];
  try {
    for (const item of template) {
      output.write(`\n${item.question}\n`);
      output.write(`선택: ${item.allowedDecisions.join(" / ")}\n`);
      let decision = "";
      while (!item.allowedDecisions.includes(decision)) decision = (await rl.question("> ")).trim();
      const note = (await rl.question("근거/메모(선택): ")).trim();
      answers.push({ questionId: item.questionId, decision, note, resolvedAt: new Date().toISOString() });
    }
  } finally { rl.close(); }
  return answers;
}

async function main() {
  const harness = resolve(value("--harness-run", await latest(join(ROOT, ".cache", "improvement-harness"))));
  const questions = await readJsonl(resolve(value("--questions", join(harness, "human-questions.jsonl"))));
  const template = buildHumanAnswerTemplate(questions);
  const templatePath = resolve(value("--template-output", join(harness, "human-answer-template.jsonl")));
  await mkdir(dirname(templatePath), { recursive: true });
  await writeFile(templatePath, jsonl(template));
  let answers = [];
  const answersPath = value("--answers");
  if (answersPath) answers = await readJsonl(resolve(answersPath));
  else if (has("--interactive") && questions.length) answers = await interactiveAnswers(template);
  const result = resolveHumanAnswers(questions, answers);
  if (result.errors.length) throw new Error(result.errors.join("\n"));
  const decisionsPath = resolve(value("--output", join(harness, "human-decisions.jsonl")));
  await writeFile(decisionsPath, jsonl(result.resolved));
  console.log(`Human questions: ${questions.length}`);
  console.log(`Resolved: ${result.resolved.length}`);
  console.log(`Pending: ${result.pending.length}`);
  console.log(`Template: ${templatePath}`);
  console.log(`Decisions: ${decisionsPath}`);
  if (result.pending.length) process.exitCode = 2;
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
