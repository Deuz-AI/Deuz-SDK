import type { JSONSchema } from '../types/schema';

/**
 * Gemini's restricted OpenAPI-subset schema dialect. Types are UPPERCASE and a
 * fair amount of JSON Schema is unsupported ($ref / oneOf / anyOf /
 * additionalProperties etc. are stripped). `propertyOrdering` is injected from
 * key order so structured output is deterministic.
 */
export interface GeminiSchema {
  type?: 'OBJECT' | 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN' | 'ARRAY';
  properties?: Record<string, GeminiSchema>;
  items?: GeminiSchema;
  required?: string[];
  propertyOrdering?: string[];
  nullable?: boolean;
  /** Enum values keep their declared JSON type (string | number | boolean). */
  enum?: (string | number | boolean)[];
  description?: string;
  format?: string;
}

const TYPE_MAP: Record<string, GeminiSchema['type']> = {
  object: 'OBJECT',
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
};

interface JSONSchemaNode {
  type?: string | string[];
  properties?: Record<string, JSONSchemaNode>;
  items?: JSONSchemaNode;
  required?: string[];
  enum?: unknown[];
  description?: string;
  format?: string;
  // Unsupported keys we deliberately ignore: $ref, oneOf, anyOf, allOf, additionalProperties.
}

/**
 * Convert a JSON Schema to Gemini's restricted dialect. `jsonSchemaMode:true`
 * is for the fuller `responseJsonSchema` (Gemini 3) path — currently the same
 * conversion, kept as a seam for future divergence.
 */
export function toGeminiSchema(
  schema: JSONSchema,
  opts?: { jsonSchemaMode?: boolean },
): GeminiSchema {
  void opts;
  return convert(schema as JSONSchemaNode);
}

function convert(node: JSONSchemaNode): GeminiSchema {
  const out: GeminiSchema = {};

  // type may be ['string','null'] → mark nullable + take the non-null type.
  let type = node.type;
  if (Array.isArray(type)) {
    if (type.includes('null')) out.nullable = true;
    type = type.find((t) => t !== 'null');
  }
  if (typeof type === 'string' && TYPE_MAP[type]) out.type = TYPE_MAP[type];

  if (node.description) out.description = node.description;
  if (node.format) out.format = node.format;
  if (Array.isArray(node.enum)) {
    // Preserve enum values in their declared type (integer enums must NOT become
    // strings — that breaks the type contract). Only default to STRING when no
    // explicit type was given AND every value is a string.
    out.enum = node.enum as (string | number | boolean)[];
    if (!out.type && node.enum.every((v) => typeof v === 'string')) out.type = 'STRING';
  }

  if (node.properties && typeof node.properties === 'object') {
    const keys = Object.keys(node.properties);
    out.properties = {};
    for (const k of keys) out.properties[k] = convert(node.properties[k]!);
    // Deterministic ordering — Gemini honors propertyOrdering for output.
    out.propertyOrdering = keys;
    if (!out.type) out.type = 'OBJECT';
  }

  if (node.required && node.required.length) out.required = [...node.required];

  if (node.items) {
    out.items = convert(node.items);
    if (!out.type) out.type = 'ARRAY';
  }

  return out;
}
