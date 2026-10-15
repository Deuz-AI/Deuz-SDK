/**
 * The single model call of a skill proposal (2.4, spec §2.6): one request, no
 * transport retry, no tools, admitted against a ledger of its own built from
 * the mandatory budget. The source run's accounting is never touched.
 *
 * The call goes through the core pipeline (`core/inference.ts`) loaded with a
 * lazy `import()`: `/skills/learning` reaches neither the agentic loops
 * (`inference/**`) nor the provider adapters until a proposal is made, and
 * `generateObject` is not used because its repair attempt would be a second
 * call. Edge-safe.
 */
import type { Dependencies } from '../../types/deps';
import type { BudgetLimits } from '../../types/execution';
import type { Message } from '../../types/message';
import type { LanguageModel } from '../../types/model';
import type { FinishReason, Usage } from '../../types/usage';
import { createExecutionContext } from '../../execution-policy';

export interface ProposalCallInput {
  model: LanguageModel;
  messages: Message[];
  maxOutputTokens: number;
  budget: BudgetLimits;
  signal?: AbortSignal;
  deps?: Dependencies;
}

export interface ProposalCallResult {
  text: string;
  usage: Usage;
  finishReason: FinishReason;
  /** The settled charge; absent when the model has no price. */
  costUsd?: number;
}

/** The ledger scope of a proposal call. */
const SCOPE = 'skill-proposal';

export async function callProposalModel(input: ProposalCallInput): Promise<ProposalCallResult> {
  input.signal?.throwIfAborted();
  // A fresh root context per call: its budget bounds this call alone, apart
  // from the closed accounting of the run the skill is learned from.
  const execution = createExecutionContext({ budget: input.budget, scopeId: SCOPE });
  const { runStream } = await import('../../core/inference');
  const result = runStream(
    {
      model: input.model,
      messages: input.messages,
      maxOutputTokens: input.maxOutputTokens,
      // One model call by default (spec §2.6): a failed attempt is the host's to repeat.
      maxRetries: 0,
      execution,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.deps ? { deps: input.deps } : {}),
    },
    { operation: 'generate-text' },
  );
  let text = '';
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') text += part.text;
    else if (part.type === 'error') throw part.error;
  }
  const usage = await result.usage;
  const finishReason = await result.finishReason;
  // A user abort resolves the stream as `'aborted'` instead of failing it.
  input.signal?.throwIfAborted();
  const settled = execution.ledger
    .snapshot()
    .reservations.find((reservation) => reservation.state === 'settled');
  const costUsd = settled && !settled.unpriced ? settled.actual.usd : undefined;
  return { text, usage, finishReason, ...(costUsd !== undefined ? { costUsd } : {}) };
}
