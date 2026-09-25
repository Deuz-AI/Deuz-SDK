import type { AgentToolSet } from '../types/agent-run';
import type {
  SwarmAgentBinding,
  SwarmChannelPost,
  SwarmKey,
  SwarmStore,
  SwarmTask,
} from '../types/swarm';
import { encodeSwarm, SWARM_MAX_NOTE, validateChannelName } from './store';

/** Task group names double as channel names and rounds keys (2.2). */
export const SWARM_GROUP = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

/** A task posts to its group's channel; tasks without a group share 'main'. */
export const channelOf = (task: SwarmTask): string => task.group ?? 'main';

/** Channels an agent binding may read, validated once at swarm creation. */
export function readableChannels(
  config: NonNullable<SwarmAgentBinding['blackboard']>,
  task?: SwarmTask,
): string[] {
  if (config.read === undefined) return [];
  if (config.read === 'group') return task ? [channelOf(task)] : [];
  if (!Array.isArray(config.read)) throw new Error('blackboard.read must be "group" or a list');
  return config.read.map((channel) => validateChannelName(channel));
}

/**
 * The blackboard tools an agent task receives (2.2). Both are idempotent: a
 * read has no effect, and a post is keyed by task, model step and call ID, so
 * replaying an interrupted call cannot add a second note.
 */
export function blackboardTools(input: {
  key: SwarmKey;
  task: SwarmTask;
  config: NonNullable<SwarmAgentBinding['blackboard']>;
  store: SwarmStore;
  attempt: () => number;
  now: () => number;
  post: (post: SwarmChannelPost) => Promise<void>;
}): AgentToolSet {
  const own = channelOf(input.task);
  const readable = readableChannels(input.config, input.task);
  const tools: AgentToolSet = {};
  if (readable.length) {
    tools.blackboard_read = {
      description: `Read notes other agents posted to the shared board. Channels: ${readable.join(', ')}.`,
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', enum: readable },
          after: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      replay: 'idempotent',
      execute: async (args: { channel?: string; after?: number; limit?: number }) => {
        const channel = args?.channel ?? readable[0]!;
        if (!readable.includes(channel))
          throw new Error(`Channel ${channel} is not readable by this agent`);
        const entries = await input.store.readChannel!(
          input.key,
          channel,
          args?.after ?? 0,
          Math.min(args?.limit ?? 50, 100),
        );
        return entries.map((entry) => ({
          sequence: entry.sequence,
          from: entry.taskId,
          text: entry.text,
          ...(entry.data !== undefined ? { data: entry.data } : {}),
        }));
      },
    };
  }
  if (input.config.post) {
    tools.blackboard_post = {
      description: `Post a short note to the ${own} board for the other agents on this problem.`,
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: SWARM_MAX_NOTE },
          data: {},
        },
        required: ['text'],
        additionalProperties: false,
      },
      replay: 'idempotent',
      execute: async (args: { text?: unknown; data?: unknown }, context) => {
        const text = args?.text;
        if (typeof text !== 'string' || !text || text.length > SWARM_MAX_NOTE)
          throw new Error(`A note needs 1..${SWARM_MAX_NOTE} characters of text`);
        // Reject unserializable data here, as a tool error, before it can reach a commit.
        encodeSwarm(args.data ?? null);
        await input.post({
          channel: own,
          entryId: JSON.stringify([input.task.id, context.modelStep ?? 0, context.toolCallId]),
          taskId: input.task.id,
          attempt: input.attempt(),
          text,
          ...(args.data !== undefined ? { data: args.data } : {}),
          at: input.now(),
        });
        return { posted: true, channel: own };
      },
    };
  }
  return tools;
}
