/**
 * server-tools.ts — provider-executed tool factories (1.2.0, spec §7 phase 1).
 *
 * These tools run ON THE PROVIDER during a turn: the model decides to call
 * them, the provider executes them server-side, and results stream back inside
 * the same response. The SDK never executes them locally; citations surface as
 * canonical `source` StreamParts. Each factory emits the raw native definition
 * for ITS wire — pass it only to models of that provider.
 *
 *   import { anthropicWebSearch } from '@deuz-sdk/core';
 *   generateText({ model, messages, tools: { web_search: anthropicWebSearch() } });
 */
import type { Tool } from './types/tool';

/** Anthropic web search config (verified against the 2026-07 tool docs). */
export interface AnthropicWebSearchConfig {
  /** Tool version. Default `web_search_20260318` (adds response_inclusion). */
  type?: 'web_search_20250305' | 'web_search_20260209' | 'web_search_20260318';
  /** Cap searches per request (error code `max_uses_exceeded` beyond it). */
  max_uses?: number;
  /** Only include results from these domains (mutually exclusive with blocked_domains). */
  allowed_domains?: string[];
  blocked_domains?: string[];
  user_location?: {
    type: 'approximate';
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
  };
  /**
   * On 20260209+ this defaults to code-execution (dynamic filtering). Models
   * without programmatic tool calling need `['direct']` — the API 400s otherwise.
   */
  allowed_callers?: string[];
  /** 20260318+: `'excluded'` drops consumed result blocks from the response. */
  response_inclusion?: 'full' | 'excluded';
}

/** Anthropic server-side web search (`/v1/messages` tools entry). */
export function anthropicWebSearch(config: AnthropicWebSearchConfig = {}): Tool {
  const { type, ...rest } = config;
  return {
    type: 'provider',
    parameters: {},
    providerTool: { type: type ?? 'web_search_20260318', name: 'web_search', ...rest },
  };
}

/** OpenAI Responses web search config. */
export interface OpenAIWebSearchConfig {
  search_context_size?: 'low' | 'medium' | 'high';
  filters?: { allowed_domains?: string[]; blocked_domains?: string[] };
  user_location?: Record<string, unknown>;
  /** Longer research runs (May 2026 param). */
  return_token_budget?: 'default' | 'unlimited';
  [key: string]: unknown;
}

/** OpenAI Responses hosted web search (`tools: [{ type: 'web_search' }]`). */
export function openaiWebSearch(config: OpenAIWebSearchConfig = {}): Tool {
  return {
    type: 'provider',
    parameters: {},
    providerTool: { type: 'web_search', ...config },
  };
}

/** Gemini Google Search grounding (`tools: [{ google_search: {} }]`). Native wire only. */
export function googleSearch(): Tool {
  return { type: 'provider', parameters: {}, providerTool: { google_search: {} } };
}
