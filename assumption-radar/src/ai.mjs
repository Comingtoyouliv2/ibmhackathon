import { analyzeWithAnthropic } from "./anthropic.mjs";
import { analyzeWithCodex } from "./codex.mjs";
import { analyzeWithAI as analyzeWithOpenAI } from "./openai.mjs";

export function semanticJudgeProvider(options = {}) {
  const explicit = options.aiProvider || process.env.SEMANTIC_JUDGE_PROVIDER;
  if (explicit) {
    if (!["openai", "anthropic", "codex"].includes(explicit)) throw new Error(`Unsupported AI provider: ${explicit}`);
    return explicit;
  }
  if (options.anthropicClient || (!process.env.OPENAI_API_KEY && process.env.ANTHROPIC_API_KEY)) return "anthropic";
  return "openai";
}

export async function analyzeWithAI(prepared, options = {}) {
  const provider = semanticJudgeProvider(options);
  if (provider === "anthropic") {
    return analyzeWithAnthropic(prepared, { ...options, client: options.anthropicClient || options.client });
  }
  if (provider === "codex") return analyzeWithCodex(prepared, options);
  return analyzeWithOpenAI(prepared, options);
}
