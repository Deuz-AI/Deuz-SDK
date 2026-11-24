/**
 * harness/policy.ts — the Deuz side of a harness's permission requests (2.5):
 * a policy by tool kind and path, a callback, and the run's approver, in that
 * order. Edge-safe: plain string matching, no `node:path`.
 */
import type { AcpPermissionOption, AcpRequestPermissionOutcome, AcpToolKind } from '../acp/types';
import type {
  HarnessDecider,
  HarnessDecision,
  HarnessDecisionOptions,
  HarnessPermissionPolicy,
  HarnessPermissionRequest,
  HarnessPermissionRule,
} from './types';

const isWindowsPath = (path: string): boolean => /^[a-zA-Z]:\//.test(path);

/**
 * A Windows path segment as the file system reads it: an NTFS stream suffix
 * (`.env::$DATA`, `a.txt:s`) names the same file, and trailing dots and spaces
 * are dropped (`.env.` opens `.env`). Segments of dots only are left alone.
 */
function windowsSegment(segment: string): string {
  if (/^\.+$/.test(segment)) return segment;
  const colon = segment.indexOf(':');
  const name = (colon === -1 ? segment : segment.slice(0, colon)).replace(/[. ]+$/, '');
  return name === '' ? segment : name;
}

/**
 * A path in `/` form with `.` and `..` segments resolved. A relative path is
 * resolved against `cwd` when one is given. A Windows drive path also loses
 * NTFS stream suffixes and trailing dots and spaces of its segments, and a
 * `\\?\` or `\\.\` prefix; a drive-relative path (`D:file`) is never resolved
 * against `cwd`, since it names the current directory of that drive.
 */
export function normalizeHarnessPath(path: string, cwd?: string): string {
  let text = path.replace(/\\/g, '/');
  if (/^\/\/[?.]\/[a-zA-Z]:\//.test(text)) text = text.slice(4);
  const absolute = text.startsWith('/') || /^[a-zA-Z]:/.test(text);
  if (!absolute && cwd !== undefined)
    text = `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${text}`;
  const drive = /^[a-zA-Z]:/.test(text) ? text.slice(0, 2) : '';
  const rest = drive ? text.slice(2) : text;
  const rooted = rest.startsWith('/');
  const out: string[] = [];
  for (const raw of rest.split('/')) {
    const segment = drive ? windowsSegment(raw) : raw;
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!rooted) out.push('..');
      continue;
    }
    out.push(segment);
  }
  return `${drive}${rooted ? '/' : ''}${out.join('/')}`;
}

function globToRegExp(glob: string, caseInsensitive: boolean): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index] as string;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index++;
        if (glob[index + 1] === '/') {
          index++;
          source += '(?:.*/)?';
        } else source += '.*';
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, caseInsensitive ? 'i' : '');
}

/**
 * Whether `path` matches `glob` (see {@link HarnessPermissionRule}). Both are
 * normalized; a relative glob is resolved against `cwd`. Matching ignores
 * case for Windows drive paths.
 */
export function matchHarnessPath(path: string, glob: string, cwd?: string): boolean {
  return matchPath(path, glob, cwd, false);
}

/** `foldCase` ignores case on every path (a deny rule: macOS and UNC shares fold case too). */
function matchPath(
  path: string,
  glob: string,
  cwd: string | undefined,
  foldCase: boolean,
): boolean {
  const target = normalizeHarnessPath(path, cwd);
  const rawGlob = glob.replace(/\\/g, '/');
  const pattern =
    rawGlob.startsWith('/') || isWindowsPath(rawGlob) || cwd === undefined
      ? rawGlob
      : `${normalizeHarnessPath(cwd)}/${rawGlob}`;
  return globToRegExp(pattern, foldCase || isWindowsPath(target)).test(target);
}

/** `null` paths could not be resolved: they never satisfy an allow rule and never match a deny rule. */
function ruleMatches(
  rule: HarnessPermissionRule,
  kind: AcpToolKind | undefined,
  paths: readonly (string | null)[],
  cwd: string | undefined,
): boolean {
  if (rule.kinds !== undefined) {
    const kinds: readonly AcpToolKind[] =
      typeof rule.kinds === 'string' ? [rule.kinds] : rule.kinds;
    if (!kinds.includes(kind ?? 'other')) return false;
  }
  if (rule.paths === undefined) return true;
  if (paths.length === 0) return false;
  const deny = rule.decision !== 'allow';
  const matches = (path: string | null) =>
    path !== null && rule.paths!.some((glob) => matchPath(path, glob, cwd, deny));
  return rule.decision === 'allow' ? paths.every(matches) : paths.some(matches);
}

function firstMatch(
  rules: readonly HarnessPermissionRule[],
  kind: AcpToolKind | undefined,
  paths: readonly (string | null)[],
  cwd: string | undefined,
): { decision: HarnessDecision; rule: string } | undefined {
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index] as HarnessPermissionRule;
    if (ruleMatches(rule, kind, paths, cwd))
      return { decision: rule.decision, rule: rule.name ?? `rules[${index}]` };
  }
  return undefined;
}

/**
 * Evaluate a policy alone: the first matching rule's decision, else
 * `policy.default` (`undefined` for `'ask'`, the default).
 *
 * With `resolvedPaths` (the real paths of `paths`, `null` where unresolved;
 * relative globs then match them against `resolvedCwd`), both forms are
 * evaluated: a deny rule matching either form denies, and an allow needs the
 * first matching rule of the real paths to allow. Otherwise `default`
 * decides. This function only compares strings: resolving the paths is the
 * caller's job (`runHarness` does it on Node).
 */
export function evaluateHarnessPolicy(
  policy: HarnessPermissionPolicy | undefined,
  request: {
    kind?: AcpToolKind;
    paths: readonly string[];
    resolvedPaths?: readonly (string | null)[];
    resolvedCwd?: string;
  },
  cwd?: string,
): { decision: HarnessDecision; rule?: string } | undefined {
  const rules = policy?.rules ?? [];
  const given = firstMatch(rules, request.kind, request.paths, cwd);
  if (request.resolvedPaths === undefined) {
    if (given) return given;
  } else {
    const real = firstMatch(rules, request.kind, request.resolvedPaths, request.resolvedCwd ?? cwd);
    if (given?.decision === 'deny') return given;
    if (real?.decision === 'deny') return real;
    if (real?.decision === 'allow') return given?.decision === 'allow' ? given : real;
  }
  const fallback = policy?.default ?? 'ask';
  return fallback === 'ask' ? undefined : { decision: fallback };
}

/** A decision before it is recorded. @internal */
export interface HarnessDecisionDraft {
  decision: HarnessDecision;
  decidedBy: HarnessDecider;
  rule?: string;
  reason?: string;
}

/**
 * Policy, then callback, then approver, then `fallback` (default deny). A
 * callback or approver that throws denies, with the error's message as the
 * reason. @internal
 */
export async function decideHarnessPermission(
  request: HarnessPermissionRequest,
  options: HarnessDecisionOptions,
  context: { cwd: string; signal: AbortSignal },
): Promise<HarnessDecisionDraft> {
  const byPolicy = evaluateHarnessPolicy(options.policy, request, context.cwd);
  if (byPolicy) {
    return {
      decision: byPolicy.decision,
      decidedBy: 'policy',
      ...(byPolicy.rule ? { rule: byPolicy.rule } : {}),
    };
  }
  if (options.onPermission) {
    try {
      const verdict = await options.onPermission(request, { signal: context.signal });
      if (verdict === 'allow' || verdict === 'deny')
        return { decision: verdict, decidedBy: 'callback' };
      if (verdict && (verdict.decision === 'allow' || verdict.decision === 'deny')) {
        return {
          decision: verdict.decision,
          decidedBy: 'callback',
          ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
        };
      }
    } catch (error) {
      return {
        decision: 'deny',
        decidedBy: 'callback',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (options.approveToolCall) {
    try {
      const approved = await options.approveToolCall(
        {
          toolCallId: request.toolCallId,
          toolName: `${request.harness}.${request.kind ?? 'other'}`,
          args: {
            ...(request.title !== undefined ? { title: request.title } : {}),
            kind: request.kind ?? 'other',
            paths: [...request.paths],
            ...(request.rawInput !== undefined ? { rawInput: request.rawInput } : {}),
          },
        },
        { messages: [] },
      );
      return { decision: approved === true ? 'allow' : 'deny', decidedBy: 'approver' };
    } catch (error) {
      return {
        decision: 'deny',
        decidedBy: 'approver',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { decision: options.fallback ?? 'deny', decidedBy: 'fallback' };
}

/**
 * The ACP answer for a decision: a `*_once` option where the harness offered
 * one (so the next call is asked about again), else its `*_always` option,
 * else `cancelled`. @internal
 */
export function harnessOutcome(
  decision: HarnessDecision,
  options: readonly AcpPermissionOption[],
): AcpRequestPermissionOutcome {
  const [once, always] =
    decision === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  const option =
    options.find((entry) => entry.kind === once) ?? options.find((entry) => entry.kind === always);
  return option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' };
}
