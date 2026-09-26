/**
 * evolve/prompt.ts — the default mutation prompt for `./evolve` (2.2): the
 * parent with its metrics and evaluator artifacts, a crossover partner, top and
 * diverse inspirations, and recent failures with their stderr (OpenEvolve's
 * artifact side channel). Pure string building.
 */
import type { EvolveMutationPrompt, EvolvePromptContext, EvolvePromptProgram } from './types';

const MAX_ARTIFACT = 2000;

const DIFF_RULES = `Reply with one or more SEARCH/REPLACE blocks in exactly this form:
<<<<<<< SEARCH
exact lines copied from the current program
=======
the lines that replace them
>>>>>>> REPLACE
Each SEARCH must match exactly once, inside an EVOLVE-BLOCK region. Code outside the EVOLVE-BLOCK-START / EVOLVE-BLOCK-END markers is frozen: never edit it and never add or remove markers.`;

const FULL_RULES = `Reply with the complete program in a single fenced code block. Rewrite only the code between the EVOLVE-BLOCK-START and EVOLVE-BLOCK-END markers; keep every marker and all code outside them byte-for-byte identical.`;

function truncate(text: string): string {
  return text.length > MAX_ARTIFACT ? `${text.slice(0, MAX_ARTIFACT)}\n…(truncated)` : text;
}

function describe(title: string, item: EvolvePromptProgram, withProgram = true): string {
  const lines = [`## ${title}${item.score !== undefined ? ` (score ${item.score})` : ''}`];
  if (item.metrics && Object.keys(item.metrics).length)
    lines.push(
      `Metrics: ${Object.entries(item.metrics)
        .map(([name, value]) => `${name}=${value}`)
        .join(', ')}`,
    );
  if (item.rejection)
    lines.push(
      `Rejected (${item.rejection.kind}${item.rejection.stage ? `, stage ${item.rejection.stage}` : ''}): ${item.rejection.message}`,
    );
  for (const [name, value] of Object.entries(item.artifacts ?? {}))
    lines.push(`${name}:\n${truncate(value)}`);
  if (withProgram) lines.push('```', item.program.replace(/\n$/, ''), '```');
  return lines.join('\n');
}

/** Build the system and user messages for one mutation. */
export function buildMutationPrompt(context: EvolvePromptContext): EvolveMutationPrompt {
  const role =
    'You are an expert programmer improving a program through evolutionary search. Every candidate is scored by an automated evaluator; a higher score is better.';
  const task =
    context.patchType === 'diff'
      ? `Propose a focused improvement to the current program. ${DIFF_RULES}`
      : context.patchType === 'cross'
        ? `Combine the strongest ideas of the two parent programs into one better program. ${FULL_RULES}`
        : `Propose a substantially improved version of the current program. ${FULL_RULES}`;
  const sections: string[] = [];
  if (context.instructions) sections.push(`# Task\n${context.instructions}`);
  sections.push(describe('Current program', context.parent));
  if (context.secondParent) sections.push(describe('Second parent', context.secondParent));
  context.inspirations.forEach((item, index) =>
    sections.push(describe(`Inspiration ${index + 1}`, item)),
  );
  context.failures?.forEach((item, index) =>
    sections.push(describe(`Recent failed attempt ${index + 1}`, item, false)),
  );
  sections.push(`Generation ${context.generation}. Improve the current program's score.`);
  return { system: `${role}\n\n${task}`, prompt: sections.join('\n\n') };
}
