/**
 * Headless chat components — zero styling, zero business logic. They only
 * wire core types (`ToolApprovalRequest`/`ToolApprovalResponse`, the useChat
 * cost state) to DOM events; presentation is overridable via render props.
 */
import type { ReactNode } from 'react';
import type { ToolApprovalRequest, ToolApprovalResponse } from '@deuz-sdk/core';
import type { UseChatCost } from './use-chat';

export interface ToolApprovalCardProps {
  approval: ToolApprovalRequest;
  /** Feed this straight into `useChat().addToolApprovalResponse`. */
  onRespond: (response: ToolApprovalResponse) => void;
  /** Override presentation; the component supplies the wired callbacks. */
  render?: (ctx: {
    approval: ToolApprovalRequest;
    approve: () => void;
    deny: (reason?: string) => void;
  }) => ReactNode;
}

/**
 * One pending tool approval. The verdict always carries the request's signed
 * `token` (D4) — callers never have to thread it themselves.
 */
export function ToolApprovalCard({ approval, onRespond, render }: ToolApprovalCardProps) {
  const respond = (approved: boolean, reason?: string): void =>
    onRespond({
      approvalId: approval.approvalId,
      approved,
      ...(reason !== undefined ? { reason } : {}),
      ...(approval.token !== undefined ? { token: approval.token } : {}),
    });
  const approve = (): void => respond(true);
  const deny = (reason?: string): void => respond(false, reason);

  if (render) return <>{render({ approval, approve, deny })}</>;
  return (
    <div data-deuz="tool-approval">
      <span data-deuz="tool-approval-name">{approval.toolName}</span>
      <pre data-deuz="tool-approval-input">{JSON.stringify(approval.input, null, 2)}</pre>
      <button type="button" onClick={approve}>
        Approve
      </button>
      <button type="button" onClick={() => deny()}>
        Deny
      </button>
    </div>
  );
}

export interface CostBadgeProps {
  /** The `useChat` cost state (undefined until the first `cost` part arrives). */
  cost: UseChatCost | undefined;
  /** Override presentation. */
  format?: (cost: UseChatCost) => ReactNode;
}

/** Live cost readout: `$X.XXXX`, plus ` (saved $Y.YYYY)` when caching saved money. */
export function CostBadge({ cost, format }: CostBadgeProps) {
  if (cost === undefined) return null;
  if (format) return <>{format(cost)}</>;
  const saved =
    cost.cacheSavingsUsd !== undefined && cost.cacheSavingsUsd > 0
      ? ` (saved $${cost.cacheSavingsUsd.toFixed(4)})`
      : '';
  return <span data-deuz="cost-badge">{`$${cost.costUsd.toFixed(4)}${saved}`}</span>;
}
