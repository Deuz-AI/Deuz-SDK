/**
 * `@deuz-sdk/react` — React bindings for the Deuz SDK.
 *
 * Thin adapter over `@deuz-sdk/core/chat` (the pure chat engine) and the Deuz
 * UI wire (`@deuz-sdk/core/ui`): `useChat`/`useObject` hooks plus minimal
 * headless components. Supersedes the frozen `@deuz-sdk/core/react` subpath.
 */
export { useChat, partsFromFiles } from './use-chat';
export type {
  UseChatOptions,
  UseChatResult,
  UseChatCost,
  UseChatBudgetExceeded,
  UseChatResumeOptions,
  UseChatCursorStore,
} from './use-chat';

export { useObject } from './use-object';
export type { UseObjectOptions, UseObjectResult } from './use-object';

export { ToolApprovalCard, CostBadge } from './components';
export type { ToolApprovalCardProps, CostBadgeProps } from './components';

// Core types consumers of the hooks/components typically need. `UIMessagePart`
// is what a renderer switches on to draw the ordered projection (1.9), and
// `ChatInput` is what `sendMessage` accepts.
export type {
  UIMessage,
  UIMessagePart,
  UIToolCall,
  AssistantTurnState,
  ChatHistory,
  ChatInput,
} from '@deuz-sdk/core/chat';
export type { DeuzUIPart } from '@deuz-sdk/core/ui';
export type { Message, ToolApprovalRequest, ToolApprovalResponse } from '@deuz-sdk/core';
