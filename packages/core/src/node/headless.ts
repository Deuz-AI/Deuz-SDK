/**
 * `@deuz-sdk/core/headless` (2.3, a PREVIEW, not a stable API): run, resume and
 * inspect native agent runs from a script or CI job, and check a provider /
 * model / configuration before running it. Node-only: it reads project
 * instruction files and skill folders from disk and the environment. There is
 * no `bin` and no CLI package; `examples/13-headless` shows a command line built
 * on it.
 *
 * Every function returns plain JSON — a {@link HeadlessReport} or a
 * {@link DoctorReport} — and {@link exitCodeFor} maps it to a documented exit
 * code, so a run that did not complete never exits 0.
 */
import type {
  AgentEvent,
  AgentResult,
  AgentRunEnvelope,
  AgentRunOptions,
  AgentRunSession,
  AgentRunStore,
  AgentStream,
  AgentToolSet,
} from '../types/agent-run';
import type { Dependencies } from '../types/deps';
import type { Message } from '../types/message';
import type { CallWarning } from '../types/methods';
import { resumeStreamAgent, streamAgent } from '../agent-run';
import { createPriceProvider } from '../pricing';
import { resolveDependencies } from '../internal/resolve-deps';
import { createWarningSink } from '../internal/warnings';
import { EMPTY_USAGE } from '../core/metering';
import { createSkillRegistry, normalizeResourcePath, renderSkillCatalog } from '../skills';
import { nodeSkillSource } from '../skills/node';
import { reportFromEnvelope, reportFromResult, type HeadlessReport } from '../headless/report';
import { diagnose, type DoctorOptions, type DoctorReport } from '../headless/doctor';
import {
  DEFAULT_INSTRUCTION_BYTES,
  DEFAULT_INSTRUCTION_FILES,
  renderProjectInstructions,
  type InstructionSource,
  type ProjectInstructions,
  type ProjectInstructionsOptions,
} from '../headless/instructions';

export {
  HEADLESS_EXIT_CODES,
  exitCodeFor,
  type HeadlessCost,
  type HeadlessOutcome,
  type HeadlessPendingAction,
  type HeadlessReport,
  type HeadlessRetry,
} from '../headless/report';
export type {
  DoctorFinding,
  DoctorOptions,
  DoctorReport,
  DoctorSeverity,
} from '../headless/doctor';
export type {
  ProjectInstructionFile,
  ProjectInstructions,
  ProjectInstructionsOptions,
} from '../headless/instructions';

// Minimal node shapes; the `as string` specifiers keep tsup's dts builder from
// statically resolving node: (matches node/observe.ts / node/compute.ts).
interface NodeFs {
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  realpath(path: string): Promise<string>;
}
interface NodePath {
  resolve(...parts: string[]): string;
  join(...parts: string[]): string;
  dirname(path: string): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
}

interface NodeProcess {
  env: Record<string, string | undefined>;
  versions: { node: string };
}

async function loadProcess(): Promise<NodeProcess> {
  return (await import('node:process' as string)) as unknown as NodeProcess;
}

async function loadFs(): Promise<{ fs: NodeFs; path: NodePath }> {
  const fs = (await import('node:fs/promises' as string)) as unknown as NodeFs;
  const path = (await import('node:path' as string)) as unknown as NodePath;
  return { fs, path };
}

/** A missing file, or a directory where a file was expected: nothing to read. */
function isAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR';
}

/**
 * `rel`, a `path.relative` result, leaves the directory it is relative to. An
 * absolute result means another drive or share, which `..` never reaches.
 */
function leaves(path: NodePath, rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/** The nearest directory from `start` upwards that holds a `.git` entry. */
async function gitRoot(fs: NodeFs, path: NodePath, start: string): Promise<string | undefined> {
  for (let dir = start; ; ) {
    try {
      await fs.stat(path.join(dir, '.git'));
      return dir;
    } catch (error) {
      if (!isAbsent(error)) throw error;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The project's instruction files as one system message, or a user message
 * with `role: 'user'` (2.3 preview). Reads `AGENTS.md`, then `CLAUDE.md`, in
 * every directory from the root down to `dir`: the root is the nearest
 * directory holding `.git` (only `dir` outside a repository) unless
 * `options.root` names one. Outer files come first, so the text nearest `dir`
 * comes last and wins a conflict; files below `dir` are not read, and `@path`
 * imports are not expanded. A file that repeats an earlier one's text is
 * included once. The text is capped at `maxBytes` (32 KiB), keeping the files
 * nearest `dir` whole first. A link (a symlink, a junction) is followed only
 * while it stays inside the root: a file whose real path is outside the
 * root's is not read, and `skipped` lists it. Rejects with a TypeError when
 * `dir` is not a directory.
 *
 * Trust: the files get the trust of a system message, like your own
 * instructions, so whoever can change them (a pull request from a fork) can
 * steer the run and its tools. Review the AGENTS.md and CLAUDE.md files of a
 * checkout you do not trust before loading them, or do not load them;
 * `role: 'user'` lowers them to user-role context, which the model weighs
 * below the system message, but it does not make them safe.
 */
export async function loadProjectInstructions(
  dir: string,
  options: ProjectInstructionsOptions = {},
): Promise<ProjectInstructions> {
  const { fs, path } = await loadFs();
  const start = path.resolve(dir);
  // A mistyped directory must not quietly read its ancestors' files instead.
  const found = await fs.stat(start).catch((error: unknown) => {
    if (isAbsent(error)) return undefined;
    throw error;
  });
  if (!found?.isDirectory()) throw new TypeError(`Not a directory: ${dir}`);
  const root =
    options.root !== undefined
      ? path.resolve(options.root)
      : ((await gitRoot(fs, path, start)) ?? start);
  const below = path.relative(root, start);
  if (leaves(path, below)) throw new TypeError('root must be dir or one of its ancestors.');
  const dirs = [root];
  for (const segment of below.split(path.sep).filter(Boolean))
    dirs.push(path.join(dirs.at(-1)!, segment));
  // A checkout can carry a link to any file on the machine (AGENTS.md ->
  // ~/.npmrc): only a real path inside the root's real path is read. Both sides
  // are resolved, so a root reached through a link (macOS /var) still counts.
  const realRoot = await fs.realpath(root);
  const sources: InstructionSource[] = [];
  const skipped: ProjectInstructions['skipped'] = [];
  for (const directory of dirs) {
    for (const name of options.fileNames ?? DEFAULT_INSTRUCTION_FILES) {
      const file = path.join(directory, name);
      const relativePath = path.relative(root, file).split(path.sep).join('/');
      try {
        const real = await fs.realpath(file);
        if (leaves(path, path.relative(realRoot, real))) {
          skipped.push({ path: file, relativePath, reason: 'outside-root' });
          continue;
        }
        sources.push({ path: file, relativePath, text: await fs.readFile(real, 'utf-8') });
      } catch (error) {
        if (!isAbsent(error)) throw error;
      }
    }
  }
  return renderProjectInstructions(root, sources, {
    maxBytes: options.maxBytes ?? DEFAULT_INSTRUCTION_BYTES,
    role: options.role,
    skipped,
  });
}

/** The tools a headless run gets for its `skills`. */
const SKILL_TOOLS = ['load_skill', 'read_skill_resource'] as const;

const decoder = new TextDecoder();

/**
 * Skills from `dirs` (`<id>/SKILL.md` folders, read by `nodeSkillSource`): the
 * catalog for the system message, and the tools that load a skill on demand.
 * The tools are the same whatever the folders hold, so a resume binds to them.
 */
async function loadSkills(
  dirs: readonly string[],
  tools: AgentToolSet | undefined,
  withCatalog: boolean,
): Promise<{ catalog?: string; tools: AgentToolSet }> {
  for (const name of SKILL_TOOLS) {
    if (tools && Object.hasOwn(tools, name))
      throw new TypeError(`The tool name '${name}' is taken by skills; rename your tool.`);
  }
  const { fs, path } = await loadFs();
  const registry = createSkillRegistry({ source: nodeSkillSource([...dirs]) });
  // Only an id the catalog lists is read, so an id cannot point outside `dirs`.
  const listed = async (id: string): Promise<void> => {
    const catalog = await registry.catalog();
    if (!catalog.some((skill) => skill.id === id))
      throw new Error(
        `Unknown skill '${id}'. Available: ${catalog.map((skill) => skill.id).join(', ') || 'none'}.`,
      );
  };
  // A link in a skill folder can point at any file on the machine, so a file
  // is read only when its real path is inside `<real dir>/<id>`. The folder is
  // the one nodeSkillSource reads: the first of `dirs` holding `<id>/SKILL.md`.
  const inFolder = async (id: string, file: string): Promise<void> => {
    for (const dir of dirs) {
      const folder = path.join(dir, id);
      try {
        await fs.stat(path.join(folder, 'SKILL.md'));
      } catch {
        continue; // not in this folder
      }
      let real: string;
      try {
        real = await fs.realpath(path.join(folder, file));
      } catch (error) {
        if (isAbsent(error)) return; // the read reports the missing file
        throw error;
      }
      if (leaves(path, path.relative(path.join(await fs.realpath(dir), id), real)))
        throw new Error(
          `'${file}' of skill '${id}' is not read: a link leads it outside the skill folder.`,
        );
      return;
    }
  };
  const id = { type: 'string', description: 'The skill id from the available skills list.' };
  const skillTools: AgentToolSet = {
    load_skill: {
      description: 'Load the full instructions of a skill, by its id.',
      parameters: {
        type: 'object',
        properties: { id },
        required: ['id'],
        additionalProperties: false,
      },
      replay: 'idempotent',
      execute: async ({ id: skill }: { id: string }) => {
        await listed(skill);
        await inFolder(skill, 'SKILL.md');
        return (await registry.trigger(skill)).body;
      },
    },
    read_skill_resource: {
      description: 'Read a text file bundled with a skill, by the skill id and the file path.',
      parameters: {
        type: 'object',
        properties: {
          id,
          path: { type: 'string', description: 'The file path, relative to the skill folder.' },
        },
        required: ['id', 'path'],
        additionalProperties: false,
      },
      replay: 'idempotent',
      execute: async ({ id: skill, path: file }: { id: string; path: string }) => {
        await listed(skill);
        await inFolder(skill, normalizeResourcePath(file));
        const data = await registry.resource(skill, file);
        return typeof data === 'string' ? data : decoder.decode(data);
      },
    },
  };
  const catalog = withCatalog ? renderSkillCatalog(await registry.catalog()) : '';
  return {
    ...(catalog
      ? {
          catalog: `Skills hold instructions for specific tasks. When a task matches one, call load_skill with its id before you start, and read_skill_resource for a file it names.\n${catalog}`,
        }
      : {}),
    tools: { ...tools, ...skillTools },
  };
}

/** Where a headless run is stored, and how its leg is observed (2.3 preview). */
export interface HeadlessSessionOptions {
  /**
   * A durable native run store. `createSqliteOpsStore({ path }).agentRuns` from
   * `@deuz-sdk/core/ops/sqlite` is the default choice for one machine; any
   * `AgentRunStore` works (Postgres, Redis, or the in-memory store in tests).
   */
  store: AgentRunStore;
  /** Application-selected tenant / workflow scope, checked on every resume. Default `'headless'`. */
  scope?: string;
  /**
   * Skill folders (`<id>/SKILL.md`, read with `nodeSkillSource`). A run's first
   * leg lists the skills in its system message, and every leg gets the tools
   * `load_skill` and `read_skill_resource`, which read a listed skill on
   * demand; neither reads a file that a link leads outside its skill folder.
   * Pass the same folders when resuming: the tools are part of the run's
   * binding.
   */
  skills?: readonly string[];
  /**
   * Every event of the leg as it happens (text deltas, tool states, warnings,
   * the result), for progress output. It must not throw: an error it throws
   * rejects the call once the run has settled.
   */
  onEvent?: (event: AgentEvent<unknown>) => void;
}

/**
 * `runHeadless` options (2.3 preview): `runAgent`'s, with the session made from
 * `store`, `runId` and `scope`.
 */
export type HeadlessRunOptions<T = string> = AgentRunOptions<T> &
  HeadlessSessionOptions & {
    /** The run's ID. Default: a generated one (`deps.generateId`). */
    runId?: string;
    /**
     * Load the project's AGENTS.md / CLAUDE.md files from this directory
     * ({@link loadProjectInstructions}) into the system message, after
     * `instructions` and before the skills list; with
     * `projectInstructions.role: 'user'`, into a user message ahead of the
     * input instead. They get that message's trust: see the caveat on
     * {@link loadProjectInstructions} before loading a checkout you do not
     * trust. A file that a link leads outside the project root is left out and
     * reported in `warnings`.
     */
    projectDir?: string;
    /** How {@link loadProjectInstructions} searches `projectDir`, and the message's role. */
    projectInstructions?: ProjectInstructionsOptions;
    session?: never;
  };

/**
 * `resumeHeadless` options (2.3 preview): `resumeAgent`'s, with the session
 * made from `store`, `runId` and `scope`. Pass the same model, tools, skills
 * and output as the first leg: the run's binding rejects a change.
 */
export type HeadlessResumeOptions<T = string> = AgentRunOptions<T> &
  HeadlessSessionOptions & {
    runId: string;
    session?: never;
    prompt?: never;
    messages?: never;
    instructions?: never;
  };

/** Price model calls with the bundled table unless the caller brought a price provider. */
function pricedDeps(deps: Dependencies | undefined): Dependencies {
  return deps?.priceProvider ? deps : { ...deps, priceProvider: createPriceProvider() };
}

/**
 * The run's input with `context` as its first user message, ahead of the
 * `messages` or the `prompt` (which becomes a user turn of its own). Input
 * `runAgent` rejects (none, or both) is left as it is, so the run reports it.
 */
function withContext(
  input: { prompt?: string; messages?: Message[] },
  context: Message,
): { prompt?: undefined; messages?: Message[] } {
  const prompt = typeof input.prompt === 'string' && input.prompt !== '';
  const messages = input.messages !== undefined && input.messages.length > 0;
  if (prompt === messages) return {};
  const turns = prompt ? [{ role: 'user', content: input.prompt! } as Message] : input.messages!;
  return { prompt: undefined, messages: [context, ...turns] };
}

/**
 * Drain one leg's events, then report its result with the stored run's phase.
 * `before` holds the warnings found before the leg started.
 */
async function report(
  stream: AgentStream<unknown>,
  session: AgentRunSession,
  onEvent: HeadlessSessionOptions['onEvent'],
  before: readonly CallWarning[] = [],
): Promise<HeadlessReport> {
  const warnings = createWarningSink();
  for (const warning of before) warnings.add(warning, { mirror: false });
  let callbackError: { error: unknown } | undefined;
  for await (const event of stream.events) {
    if (event.type === 'part' && event.part.type === 'warning')
      warnings.add(event.part.warning, { mirror: false });
    if (onEvent && !callbackError) {
      try {
        onEvent(event);
      } catch (error) {
        callbackError = { error };
      }
    }
  }
  const result: AgentResult<unknown> = await stream.result;
  if (callbackError) throw callbackError.error;
  let stored: AgentRunEnvelope | undefined;
  try {
    stored = await session.store.load(session.runId);
  } catch (error) {
    warnings.add(
      {
        type: 'other',
        message: `The stored run could not be read back: ${error instanceof Error ? error.message : String(error)}`,
      },
      { mirror: false },
    );
  }
  return reportFromResult(result, {
    scope: session.scope,
    ...(stored ? { stored } : {}),
    warnings: warnings.list(),
  });
}

function split<O extends HeadlessSessionOptions & { runId?: string; deps?: Dependencies }>(
  options: O,
): {
  session: AgentRunSession;
  onEvent: HeadlessSessionOptions['onEvent'];
  skills: HeadlessSessionOptions['skills'];
  rest: Omit<O, 'store' | 'runId' | 'scope' | 'onEvent' | 'skills'>;
} {
  const { store, runId, scope, onEvent, skills, ...rest } = options;
  return {
    session: {
      store,
      runId: runId ?? resolveDependencies(options.deps).generateId(),
      scope: scope ?? 'headless',
    },
    onEvent,
    skills,
    rest,
  };
}

/**
 * Start a native run (2.3 preview): `streamAgent` with a durable session, its
 * events drained, and a {@link HeadlessReport} of the result. The system
 * message is `instructions`, then the project instructions of `projectDir`,
 * then the skills list; with `projectInstructions.role: 'user'`, the project
 * instructions are the first user message instead. Calls are priced with the
 * bundled table unless `deps.priceProvider` is given. Whatever happens to the
 * run is in the report; it rejects only when the project files or skills
 * cannot be read, a tool takes a skill tool's name, or `onEvent` threw.
 */
export async function runHeadless<T = string>(
  options: HeadlessRunOptions<T>,
): Promise<HeadlessReport> {
  const { session, onEvent, skills, rest } = split(options);
  const { projectDir, projectInstructions, ...agent } = rest;
  const project =
    projectDir !== undefined
      ? await loadProjectInstructions(projectDir, projectInstructions)
      : undefined;
  const loaded = skills?.length ? await loadSkills(skills, agent.tools, true) : undefined;
  const message = project?.message;
  const context = message?.role === 'user' ? message : undefined;
  const system = [agent.instructions, context ? undefined : message?.content, loaded?.catalog]
    .filter((text): text is string => typeof text === 'string' && text !== '')
    .join('\n\n');
  const stream = streamAgent({
    ...(agent as AgentRunOptions<T>),
    ...(context ? withContext(agent, context) : {}),
    ...(system ? { instructions: system } : {}),
    ...(loaded ? { tools: loaded.tools } : {}),
    deps: pricedDeps(agent.deps),
    session,
  });
  const unread = (project?.skipped ?? []).map(
    (file): CallWarning => ({
      type: 'other',
      setting: 'projectDir',
      message: `The project instruction file ${file.relativePath} was not read: a link leads it outside the project root.`,
    }),
  );
  return report(stream as AgentStream<unknown>, session, onEvent, unread);
}

/**
 * Continue a stored native run (2.3 preview): `resumeStreamAgent` with the
 * answers the previous report asked for, reported like {@link runHeadless}.
 * Each pending action names its option (`approvalResponses`,
 * `clientToolResults`, and `retryToolCallIds` or `reconciledToolResults` for
 * an unknown effect); a report with `retry` takes `retryFailed: true`. An
 * answer the run cannot take (a call it does not wait on, a call both run
 * again and recorded, a retry of a failure that was not transient) fails the
 * leg with a TypeError before anything is written: the stored run stays as
 * it was.
 */
export async function resumeHeadless<T = string>(
  options: HeadlessResumeOptions<T>,
): Promise<HeadlessReport> {
  const { session, onEvent, skills, rest } = split(options);
  const loaded = skills?.length ? await loadSkills(skills, rest.tools, false) : undefined;
  const stream = resumeStreamAgent({
    ...(rest as AgentRunOptions<T>),
    ...(loaded ? { tools: loaded.tools } : {}),
    deps: pricedDeps(rest.deps),
    session,
  });
  return report(stream as AgentStream<unknown>, session, onEvent);
}

/**
 * The report of a stored run (2.3 preview), read from `store` with no model
 * call: its outcome, what it waits for, usage and cost. A run with no result
 * yet reports `status: 'in-progress'` and a pending `'resume'`, with any call
 * whose effect is unknown; that is accurate only when no executor still drives
 * it. Rejects an unknown run ID with a TypeError.
 */
export async function inspectRun(store: AgentRunStore, runId: string): Promise<HeadlessReport> {
  const envelope = await store.load(runId);
  if (!envelope) throw new TypeError(`Unknown native run: ${runId}`);
  if (envelope.kind !== 'deuz-agent-run' || envelope.runId !== runId)
    throw new TypeError(`Not a native run record: ${runId}`);
  return reportFromEnvelope(envelope);
}

/**
 * A provider / model / configuration report (2.3 preview), before any run and
 * with no network call: the model's profile and how well the SDK knows it
 * (`resolveModelProfile`, the registry), how effort, sampling and structured
 * output reach the wire, whether the model has a price, where the API key
 * comes from, and whether this Node version is supported. Each problem is a
 * finding; an `error` finding means the run will not work as configured, and
 * `exitCodeFor` returns 8 for it. Pass the run's own options. Only a
 * `deps.priceProvider` you gave is called (once, with a two-token usage); a
 * `deps.keyProvider` is not called.
 */
export async function doctor(options: DoctorOptions): Promise<DoctorReport> {
  const host =
    options.env === undefined || options.nodeVersion === undefined
      ? await loadProcess()
      : undefined;
  const prices = options.deps?.priceProvider ?? createPriceProvider();
  let priced: boolean | undefined;
  let priceError: string | undefined;
  try {
    const usd = await prices.priceUsage(options.model.modelId, {
      ...EMPTY_USAGE,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    });
    priced = usd !== undefined;
  } catch (error) {
    priceError = error instanceof Error ? error.message : String(error);
  }
  return diagnose(options, {
    env: options.env ?? host!.env,
    nodeVersion: options.nodeVersion ?? host!.versions.node,
    priced,
    ...(priceError !== undefined ? { priceError } : {}),
  });
}
