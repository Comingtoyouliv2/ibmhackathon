/**
 * Step 0 / sub-step 2: rule-based classification. No LLM here — deterministic,
 * cheap, auditable. A PR passes if it touches >=1 "logic" file.
 */
import type { FileClass, RawPr, Step0Result, Verdict } from './types.js';

/** Order matters: first match wins. 'logic' is the fallback. */
const FILE_RULES: Array<[FileClass, RegExp]> = [
  [
    'docs',
    /(^|\/)(docs?|examples?)\/|\.(md|mdx|txt|rst|adoc)$|(^|\/)(license|changelog|authors|contributing|code_of_conduct|codeowners)(\.|$)/i,
  ],
  [
    'test',
    /(^|\/)(__tests__|__mocks__|__snapshots__|tests?|e2e|spec|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.snap$/i,
  ],
  [
    'deps',
    /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|\.npmrc|renovate\.json5?|dependabot\.ya?ml)$/i,
  ],
  [
    'config',
    /(^|\/)\.(github|vscode|husky|devcontainer)\/|(^|\/)(tsconfig|jsconfig)[^/]*\.json$|(^|\/)\.[^/]*(eslintrc|prettierrc|babelrc|nvmrc|editorconfig|gitignore|gitattributes|dockerignore)[^/]*$|(^|\/)(eslint|prettier|jest|vitest|webpack|rollup|vite|babel|playwright|tailwind|postcss)\.config\.[^/]+$|(^|\/)(dockerfile|docker-compose[^/]*)$|\.(ya?ml|toml|ini)$/i,
  ],
  ['assets', /\.(png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|mp[34]|webm|pdf|zip)$/i],
];

/**
 * Only dependency/housekeeping bots are excluded by author. AI coding agents
 * (codex, copilot, etc.) submit real logic PRs — they are exactly our target
 * population, so they go through the normal file-based rules.
 */
const DEPS_BOT = /^(dependabot|renovate|github-actions)(\[bot\])?$/i;

export function classifyFile(filePath: string): FileClass {
  for (const [cls, re] of FILE_RULES) {
    if (re.test(filePath)) return cls;
  }
  return 'logic';
}

export function classifyPr(pr: RawPr): Step0Result {
  const fileClasses: Partial<Record<FileClass, number>> = {};
  for (const f of pr.files) {
    const cls = classifyFile(f.path);
    fileClasses[cls] = (fileClasses[cls] ?? 0) + 1;
  }
  const logicCount = fileClasses.logic ?? 0;

  let verdict: Verdict;
  let reason: string;

  if (DEPS_BOT.test(pr.authorLogin)) {
    verdict = 'excluded';
    reason = 'deps_bot_author';
  } else if (pr.files.length === 0 && !pr.filesTruncated) {
    verdict = 'excluded';
    reason = 'no_files';
  } else if (logicCount === 0 && !pr.filesTruncated) {
    // Exclude ONLY when we are certain there is zero logic change.
    const dominant = (Object.entries(fileClasses) as Array<[FileClass, number]>).sort(
      (a, b) => b[1] - a[1],
    )[0]?.[0];
    verdict = 'excluded';
    reason = `no_logic_files(${dominant ?? 'unknown'})`;
  } else if (pr.mergeable === 'CONFLICTING') {
    // Git-level conflict with main: GitHub already surfaces this; not our
    // target until rebased. Deferred, not dropped.
    verdict = 'deferred';
    reason = 'git_conflict_with_main';
  } else {
    verdict = 'pass';
    reason = pr.filesTruncated ? 'has_logic_files(file_list_truncated)' : 'has_logic_files';
  }

  return {
    pr: pr.number,
    title: pr.title,
    verdict,
    reason,
    fileClasses,
    isDraft: pr.isDraft,
    authorLogin: pr.authorLogin,
    authorIsBot: pr.authorIsBot,
    updatedAt: pr.updatedAt,
  };
}
