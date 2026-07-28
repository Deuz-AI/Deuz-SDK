import { streamChat } from '@deuz-sdk/core';
import type { Message, ToolApprovalResponse } from '@deuz-sdk/core';
import { createAnthropic } from '@deuz-sdk/core/anthropic';
import { toDeuzStreamResponse } from '@deuz-sdk/core/ui';

/**
 * Chat route. `@deuz-sdk/core` is edge-safe (Web APIs only, injected clock and
 * randomness), so this handler runs on the edge runtime unchanged.
 */
export const runtime = 'edge';

interface ChatRequestBody {
  messages: Message[];
  /** `useChat` posts these back after the user answers an approval card. */
  approvalResponses?: ToolApprovalResponse[];
}

export async function POST(request: Request): Promise<Response> {
  const { messages, approvalResponses } = (await request.json()) as ChatRequestBody;

  // The SERVER reads the key from its environment and passes it explicitly.
  // Core never touches process.env, so the key cannot leak into a bundle.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new Response('ANTHROPIC_API_KEY is not set.', { status: 500 });
  const anthropic = createAnthropic({ apiKey });

  const result = streamChat({
    model: anthropic('claude-opus-4-8'),
    messages,
    maxSteps: 5,
    tools: {
      deleteFile: {
        description: 'Delete a file from the project by path.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
        // CLIENT-MODE approval: because this call carries no `approveToolCall`,
        // the loop BREAKS here and emits a `tool-approval-request` part instead
        // of executing. The browser renders the card; the verdict comes back as
        // `approvalResponses` on the next POST and the loop resumes.
        needsApproval: true,
        execute: (args) => ({ deleted: (args as { path: string }).path }),
      },
    },
    ...(approvalResponses ? { approvalResponses } : {}),
  });

  // Canonical StreamPart stream → the versioned Deuz SSE wire that useChat reads.
  return toDeuzStreamResponse(result);
}
