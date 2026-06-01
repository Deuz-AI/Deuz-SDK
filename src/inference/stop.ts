import type { StopCondition } from '../types/tool';

/** Stop once the loop has run `n` model steps. */
export const stepCountIs =
  (n: number): StopCondition =>
  ({ stepCount }) =>
    stepCount >= n;

/** Stop once the latest step called a tool named `name`. */
export const hasToolCall =
  (name: string): StopCondition =>
  ({ steps }) =>
    steps.at(-1)?.toolCalls.some((c) => c.toolName === name) ?? false;
