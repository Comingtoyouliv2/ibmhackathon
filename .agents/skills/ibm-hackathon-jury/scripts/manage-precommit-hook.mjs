#!/usr/bin/env node

import { chmodSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function run(args, allowFailure = false) {
  const result = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return (result.stdout || "").trim();
}

const action = process.argv[2] || "status";
const root = run(["rev-parse", "--show-toplevel"]);
const current = run(["config", "--local", "--get", "core.hooksPath"], true);
const hookPath = resolve(root, ".githooks/pre-commit");

if (action === "install") {
  if (current && current !== ".githooks") {
    throw new Error(`Refusing to replace existing core.hooksPath=${current}`);
  }
  chmodSync(hookPath, 0o755);
  run(["config", "--local", "core.hooksPath", ".githooks"]);
  process.stdout.write("Installed repository-local pre-commit jury hook (.githooks).\n");
} else if (action === "uninstall") {
  if (!current) {
    process.stdout.write("No local core.hooksPath is configured.\n");
  } else if (current !== ".githooks") {
    throw new Error(`Refusing to unset unrelated core.hooksPath=${current}`);
  } else {
    run(["config", "--local", "--unset", "core.hooksPath"]);
    process.stdout.write("Uninstalled repository-local pre-commit jury hook.\n");
  }
} else if (action === "status") {
  process.stdout.write(current === ".githooks"
    ? "Pre-commit jury hook is installed.\n"
    : `Pre-commit jury hook is not installed${current ? `; current hooksPath=${current}` : ""}.\n`);
} else {
  throw new Error("Usage: manage-precommit-hook.mjs install|uninstall|status");
}
