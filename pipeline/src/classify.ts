/**
 * Step 0 / sub-step 2: rule-based classification. No LLM here — deterministic,
 * cheap, auditable. A PR passes if it touches >=1 "logic" file.
 */
import type { FileClass, PrFile, RawPr, SignalStrength, Step0Result, Verdict } from './types.js';

/**
 * Order matters: first match wins. 'logic' is the fallback.
 *
 * Config is infra/tooling only — application config under src/lib/packages
 * is NOT matched here and falls through to logic.
 */
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
    /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|\.npmrc|renovate\.json5?|dependabot\.ya?ml|pyproject\.toml|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Gemfile\.lock)$/i,
  ],
  [
    'config',
    /(^|\/)\.(github|vscode|husky|devcontainer)\/|(^|\/)(tsconfig|jsconfig)[^/]*\.json$|(^|\/)\.[^/]*(eslintrc|prettierrc|babelrc|nvmrc|editorconfig|gitignore|gitattributes|dockerignore)[^/]*$|(^|\/)(eslint|prettier|jest|vitest|webpack|rollup|vite|babel|playwright|tailwind|postcss)\.config\.[^/]+$|(^|\/)(dockerfile|docker-compose[^/]*)$|^[^/]+\.(ya?ml|toml|ini)$/i,
  ],
  ['assets', /\.(png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|mp[34]|webm|pdf|zip)$/i],
];

/**
 * Only dependency/housekeeping bots are excluded by author. AI coding agents
 * (codex, copilot, etc.) submit real logic PRs — they are exactly our target
 * population, so they go through the normal file-based rules.
 */
const DEPS_BOT = /^(dependabot|renovate|github-actions)(\[bot\])?$/i;

const LOW_LOGIC_LINE_THRESHOLD = 10;
const LOW_TOTAL_LINE_THRESHOLD = 5;

export function classifyFile(filePath: string): FileClass {
  for (const [cls, re] of FILE_RULES) {
    if (re.test(filePath)) return cls;
  }
  return 'logic';
}

export function computeChangeStats(files: PrFile[]): {
  fileClasses: Partial<Record<FileClass, number>>;
  logicFileCount: number;
  logicChangeLines: number;
  totalChangeLines: number;
} {
  const fileClasses: Partial<Record<FileClass, number>> = {};
  let logicFileCount = 0;
  let logicChangeLines = 0;
  let totalChangeLines = 0;

  for (const f of files) {
    const cls = classifyFile(f.path);
    fileClasses[cls] = (fileClasses[cls] ?? 0) + 1;
    const lines = f.additions + f.deletions;
    totalChangeLines += lines;
    if (cls === 'logic') {
      logicFileCount += 1;
      logicChangeLines += lines;
    }
  }

  return { fileClasses, logicFileCount, logicChangeLines, totalChangeLines };
}

function dominantClass(fileClasses: Partial<Record<FileClass, number>>): FileClass | 'unknown' {
  const entries = Object.entries(fileClasses) as Array<[FileClass, number]>;
  if (entries.length === 0) return 'unknown';
  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

function formatLineHint(
  logicFileCount: number,
  logicChangeLines: number,
  totalChangeLines: number,
): string {
  if (logicFileCount > 0) {
    return `${logicFileCount} logic files, ${logicChangeLines} logic lines / ${totalChangeLines} total`;
  }
  return `${totalChangeLines} total lines`;
}

function deriveSignalStrength(
  verdict: Verdict,
  pr: RawPr,
  logicFileCount: number,
  logicChangeLines: number,
  totalChangeLines: number,
): SignalStrength {
  if (pr.filesTruncated) return 'unknown';
  if (verdict !== 'pass') return 'low';
  if (logicFileCount >= 2 || logicChangeLines >= LOW_LOGIC_LINE_THRESHOLD) return 'high';
  if (logicFileCount === 1 && logicChangeLines < LOW_LOGIC_LINE_THRESHOLD && totalChangeLines > 50) {
    return 'low';
  }
  return logicChangeLines > 0 ? 'high' : 'low';
}

export function classifyPr(pr: RawPr): Step0Result {
  const { fileClasses, logicFileCount, logicChangeLines, totalChangeLines } = computeChangeStats(pr.files);
  const lineHint = formatLineHint(logicFileCount, logicChangeLines, totalChangeLines);

  let verdict: Verdict;
  let reason: string;

  if (DEPS_BOT.test(pr.authorLogin)) {
    verdict = 'excluded';
    reason = 'deps_bot_author';
  } else if (pr.files.length === 0 && !pr.filesTruncated) {
    verdict = 'excluded';
    reason = 'no_files';
  } else if (logicFileCount === 0 && !pr.filesTruncated) {
    const dominant = dominantClass(fileClasses);
    const lowSignal =
      totalChangeLines <= LOW_TOTAL_LINE_THRESHOLD ? ',low_signal' : '';
    verdict = 'excluded';
    reason = `no_logic_files(${dominant},${lineHint}${lowSignal})`;
  } else if (pr.mergeable === 'CONFLICTING') {
    verdict = 'deferred';
    reason = `git_conflict_with_main(${lineHint})`;
  } else {
    verdict = 'pass';
    const truncatedNote = pr.filesTruncated ? ',file_list_truncated' : '';
    reason = `has_logic_files(${lineHint}${truncatedNote})`;
  }

  return {
    pr: pr.number,
    title: pr.title,
    verdict,
    reason,
    fileClasses,
    logicFileCount,
    logicChangeLines,
    totalChangeLines,
    signalStrength: deriveSignalStrength(verdict, pr, logicFileCount, logicChangeLines, totalChangeLines),
    isDraft: pr.isDraft,
    authorLogin: pr.authorLogin,
    authorIsBot: pr.authorIsBot,
    updatedAt: pr.updatedAt,
  };
}
