import type { AgentValidation } from '../types/agent-run';
import type { JSONSchema, StandardSchemaV1 } from '../types/schema';
import { isStandardSchema, toJSONSchema, validateOutput } from '../schema/bridge';

export function assertAgentValidation(
  spec: { schema: StandardSchemaV1 | JSONSchema; validate?: unknown },
  label: string,
): void {
  if (!isStandardSchema(spec.schema) && typeof spec.validate !== 'function') {
    throw new TypeError(`${label}: a raw JSON Schema requires an explicit runtime validator.`);
  }
}

export async function validateAgentValue<T>(spec: AgentValidation<T>, value: unknown): Promise<T> {
  assertAgentValidation(spec, 'Agent validation');
  let current = value;
  if (isStandardSchema(spec.schema)) {
    const result = await validateOutput<T>(spec.schema, current);
    if (!result.ok) throw new TypeError(result.issues);
    current = result.value;
  }
  return spec.validate ? await spec.validate(current) : (current as T);
}

export async function agentJSONSchema<T>(spec: AgentValidation<T>): Promise<JSONSchema> {
  assertAgentValidation(spec, 'Agent output');
  return toJSONSchema(spec.schema);
}

/**
 * Extract ONLY syntactically complete top-level array elements. A closing quote,
 * brace, or bracket is insufficient for scalar literals: the next comma or
 * array close is required. Reparse from the start so split escapes remain safe.
 */
export function completedArrayElements(text: string): unknown[] {
  let start = 0;
  while (/\s/.test(text[start] ?? '') && start < text.length) start++;
  if (text[start] !== '[') return [];
  start++;
  let depth = 0;
  let quoted = false;
  let escape = false;
  const values: unknown[] = [];
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      continue;
    }
    if (c === '{' || c === '[') {
      depth++;
      continue;
    }
    if (c === '}' || (c === ']' && depth > 0)) {
      depth--;
      continue;
    }
    if (depth === 0 && (c === ',' || c === ']')) {
      const fragment = text.slice(start, i).trim();
      if (!fragment) return values;
      try {
        values.push(JSON.parse(fragment));
      } catch {
        return values;
      }
      start = i + 1;
      if (c === ']') return values;
    }
  }
  return values;
}
