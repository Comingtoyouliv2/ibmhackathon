/** Repository-local responsibility classifier used after coarse sectoring. */
import type { HierarchyAssignment, PrDiff, RawPr, SectorCard } from './types.js';

interface Rule {
  domain: string;
  subDomain: string;
  terms: string[];
}

// OpenClaw's large sectors need stable vocabulary. Repositories without a
// profile still get deterministic component-based fallback domains.
const OPENCLAW_RULES: Record<string, Rule[]> = {
  'core:agents': [
    { domain: 'session-management', subDomain: 'session-routing', terms: ['sessionkey', 'session key', 'resolve-session', 'session-delivery', 'main-session'] },
    { domain: 'session-management', subDomain: 'session-storage', terms: ['session store', 'sessions-store', 'transcript', 'store-path'] },
    { domain: 'subagent-management', subDomain: 'subagent-lifecycle', terms: ['subagent', 'sub-agent', 'spawn', 'completion delivery'] },
    { domain: 'tool-execution', subDomain: 'approval-policy', terms: ['approval', 'allowlist', 'tool policy', 'tool-policy'] },
    { domain: 'tool-execution', subDomain: 'tool-registry', terms: ['/tools/', 'tool-registry', 'message-tool', 'cron-tool', 'tool-call'] },
    { domain: 'sandbox-security', subDomain: 'execution-sandbox', terms: ['sandbox', 'permission', 'security', 'isolation'] },
    { domain: 'agent-runtime', subDomain: 'embedded-runner', terms: ['embedded-agent-runner', 'embedded runner', 'attempt.ts', 'run/'] },
    { domain: 'agent-runtime', subDomain: 'runtime-harness', terms: ['/harness/', 'runtime-plugin', 'agent harness'] },
    { domain: 'model-runtime', subDomain: 'provider-routing', terms: ['provider', 'model', 'auth profile', 'auth-profiles'] },
    { domain: 'agent-configuration', subDomain: 'default-resolution', terms: ['default agent', 'agent-scope', 'agents.list', 'agent id'] },
    { domain: 'skills-runtime', subDomain: 'skill-loading', terms: ['/skills/', 'skill loading', 'skills-status'] },
  ],
  'core:gateway': [
    { domain: 'operator-approvals', subDomain: 'approval-lifecycle', terms: ['approval', 'approve', 'first-answer'] },
    { domain: 'connection-security', subDomain: 'authentication', terms: ['auth', 'token', 'credential', 'origin policy'] },
    { domain: 'gateway-protocol', subDomain: 'rpc-contract', terms: ['server-method', 'rpc', 'protocol', 'schema'] },
    { domain: 'node-routing', subDomain: 'node-invocation', terms: ['node-invoke', 'node invoke', 'node registry'] },
    { domain: 'session-routing', subDomain: 'gateway-session', terms: ['session', 'routing', 'route'] },
    { domain: 'server-lifecycle', subDomain: 'startup-shutdown', terms: ['startup', 'shutdown', 'server-start', 'restart'] },
    { domain: 'message-delivery', subDomain: 'event-broadcast', terms: ['broadcast', 'delivery', 'send', 'event'] },
  ],
  'app:web-ui': [
    { domain: 'chat-interface', subDomain: 'message-rendering', terms: ['chat', 'message', 'composer', 'transcript'] },
    { domain: 'configuration-ui', subDomain: 'settings-editor', terms: ['config', 'settings', 'form', 'schema'] },
    { domain: 'agent-ui', subDomain: 'agent-management', terms: ['agent', 'workspace', 'model'] },
    { domain: 'operations-ui', subDomain: 'dashboard-status', terms: ['dashboard', 'status', 'usage', 'health'] },
    { domain: 'localization', subDomain: 'translations', terms: ['i18n', 'locale', 'translation'] },
  ],
  'core:config': [
    { domain: 'configuration-schema', subDomain: 'schema-validation', terms: ['schema', 'zod', 'validation', 'config type'] },
    { domain: 'configuration-migration', subDomain: 'doctor-repair', terms: ['migration', 'doctor', 'legacy', 'repair'] },
    { domain: 'session-configuration', subDomain: 'session-paths', terms: ['session', 'transcript', 'store path'] },
    { domain: 'agent-configuration', subDomain: 'agent-defaults', terms: ['agent', 'agents.list', 'default'] },
    { domain: 'plugin-configuration', subDomain: 'plugin-activation', terms: ['plugin', 'extension', 'slot'] },
    { domain: 'model-configuration', subDomain: 'provider-models', terms: ['model', 'provider', 'auth profile'] },
    { domain: 'secret-configuration', subDomain: 'credential-resolution', terms: ['secret', 'credential', 'token', 'env var'] },
  ],
  'core:auto-reply': [
    { domain: 'command-handling', subDomain: 'command-dispatch', terms: ['command', '/reset', '/new', 'directive'] },
    { domain: 'reply-session', subDomain: 'session-resolution', terms: ['session', 'sessionkey', 'agent id'] },
    { domain: 'message-delivery', subDomain: 'channel-routing', terms: ['delivery', 'route', 'channel', 'recipient'] },
    { domain: 'reply-streaming', subDomain: 'stream-lifecycle', terms: ['stream', 'chunk', 'partial'] },
    { domain: 'reply-media', subDomain: 'media-rendering', terms: ['media', 'image', 'audio', 'attachment'] },
  ],
  'core:plugins': [
    { domain: 'plugin-lifecycle', subDomain: 'install-update', terms: ['install', 'update', 'uninstall'] },
    { domain: 'plugin-lifecycle', subDomain: 'loader-runtime', terms: ['loader', 'registry', 'activation'] },
    { domain: 'plugin-contracts', subDomain: 'sdk-surface', terms: ['plugin-sdk', 'contract', 'api surface'] },
    { domain: 'plugin-configuration', subDomain: 'slot-resolution', terms: ['slot', 'config', 'manifest'] },
  ],
  'core:infra': [
    { domain: 'approval-infrastructure', subDomain: 'approval-runtime', terms: ['approval', 'approve'] },
    { domain: 'process-infrastructure', subDomain: 'process-lifecycle', terms: ['process', 'spawn', 'exec'] },
    { domain: 'network-infrastructure', subDomain: 'http-transport', terms: ['http', 'fetch', 'proxy', 'socket'] },
    { domain: 'persistence-infrastructure', subDomain: 'state-storage', terms: ['sqlite', 'state', 'store', 'database'] },
    { domain: 'delivery-infrastructure', subDomain: 'message-routing', terms: ['delivery', 'route', 'channel'] },
  ],
  'extension:codex': [
    { domain: 'codex-runtime', subDomain: 'app-server', terms: ['app-server', 'codex runtime', 'thread'] },
    { domain: 'codex-tools', subDomain: 'dynamic-tools', terms: ['dynamic-tool', 'shell tool', 'exec tool'] },
    { domain: 'codex-environment', subDomain: 'sandbox-environment', terms: ['sandbox', 'environment', 'exec-server'] },
    { domain: 'codex-session', subDomain: 'session-lifecycle', terms: ['session', 'resume', 'compaction'] },
  ],
};

const CHANNEL_RULES: Rule[] = [
  { domain: 'message-ingress', subDomain: 'inbound-routing', terms: ['inbound', 'incoming', 'handler', 'update', 'webhook', 'polling'] },
  { domain: 'message-egress', subDomain: 'outbound-delivery', terms: ['outbound', 'send', 'delivery', 'reply', 'recipient'] },
  { domain: 'message-content', subDomain: 'formatting-rendering', terms: ['format', 'markdown', 'html', 'render', 'parse mode', 'text style'] },
  { domain: 'message-content', subDomain: 'media-attachments', terms: ['media', 'attachment', 'image', 'audio', 'video', 'file'] },
  { domain: 'channel-security', subDomain: 'authentication-authorization', terms: ['auth', 'token', 'credential', 'allowlist', 'approval', 'permission'] },
  { domain: 'channel-lifecycle', subDomain: 'connection-recovery', terms: ['connect', 'disconnect', 'reconnect', 'retry', 'startup', 'shutdown'] },
  { domain: 'channel-configuration', subDomain: 'account-settings', terms: ['config', 'account', 'setting', 'schema', 'default'] },
  { domain: 'conversation-routing', subDomain: 'thread-session-mapping', terms: ['thread', 'topic', 'session', 'conversation', 'chat id'] },
];

function prefixForSector(sector: string): string | undefined {
  if (sector.startsWith('core:')) return `src/${sector.slice(5)}/`;
  if (sector.startsWith('extension:')) return `extensions/${sector.slice(10)}/`;
  if (sector.startsWith('app:')) return sector === 'app:web-ui' ? 'ui/' : `apps/${sector.slice(4)}/`;
  if (sector.startsWith('package:')) return `packages/${sector.slice(8)}/`;
  if (sector.startsWith('component:')) return `${sector.slice('component:'.length)}/`;
  if (sector.startsWith('channel:')) {
    const name = sector.slice('channel:'.length).replace(/^whatsapp-web$/, 'whatsapp');
    return `extensions/${name}/`;
  }
  if (sector === 'delivery:ci') return undefined;
  return undefined;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[_:.]+/g, ' ').replace(/\s+/g, ' ');
}

function fallbackAssignment(sector: string, files: string[]): Pick<HierarchyAssignment, 'domain' | 'subDomain' | 'evidence' | 'confidence'> {
  const prefix = prefixForSector(sector);
  const local = prefix ? files.filter((file) => file.startsWith(prefix)) : files;
  const first = local[0] ?? files[0] ?? 'unknown';
  const relative = prefix && first.startsWith(prefix) ? first.slice(prefix.length) : first;
  const parts = relative.split('/');
  const component = (parts.length > 1 ? parts[0] : parts[0].replace(/\.[^.]+$/, '').split(/[-_.]/)[0]) || 'general';
  const detail = (parts.length > 1 ? parts[1] : parts[0]).replace(/\.[^.]+$/, '').split(/[-_.]/).slice(0, 2).join('-') || 'general';
  return { domain: `component:${component}`, subDomain: `surface:${detail}`, evidence: [`path:${first}`], confidence: 0.52 };
}

export function classifyHierarchy(pr: RawPr, diff: PrDiff | undefined, sectorCard: SectorCard): HierarchyAssignment[] {
  const patchText = normalized((diff?.files ?? []).map((file) => file.patch ?? '').join('\n').slice(0, 50_000));
  const title = normalized(pr.title);
  const body = normalized(pr.body.slice(0, 4_000));
  const paths = pr.files.map((file) => file.path);
  const pathText = normalized(paths.join('\n'));
  return sectorCard.sectors.map((assignment) => {
    const rules = OPENCLAW_RULES[assignment.sector] ?? (assignment.sector.startsWith('channel:') ? CHANNEL_RULES : []);
    let best: { rule: Rule; score: number; evidence: string[] } | undefined;
    for (const rule of rules) {
      let score = 0;
      const evidence: string[] = [];
      for (const rawTerm of rule.terms) {
        const term = normalized(rawTerm);
        if (pathText.includes(term)) { score += 5; evidence.push(`path-term:${rawTerm}`); }
        if (title.includes(term)) { score += 4; evidence.push(`title-term:${rawTerm}`); }
        if (body.includes(term)) { score += 2; evidence.push(`body-term:${rawTerm}`); }
        if (patchText.includes(term)) score += 0.5;
      }
      if (!best || score > best.score) best = { rule, score, evidence };
    }
    if (!best || best.score < 2) {
      const fallback = fallbackAssignment(assignment.sector, paths);
      return { sector: assignment.sector, ...fallback };
    }
    return {
      sector: assignment.sector,
      domain: best.rule.domain,
      subDomain: best.rule.subDomain,
      evidence: best.evidence.slice(0, 4),
      confidence: Number(Math.min(0.9, 0.58 + best.score / 100).toFixed(2)),
    };
  });
}
