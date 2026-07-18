import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ToolApprovalCard, CostBadge } from '../src/components';
import type { ToolApprovalRequest, ToolApprovalResponse } from '@deuz-sdk/core';

afterEach(cleanup);

const approval: ToolApprovalRequest = {
  approvalId: 'a1',
  toolCallId: 't1',
  toolName: 'deleteFile',
  input: { path: '/tmp/x' },
  token: 'tok-1',
};

describe('ToolApprovalCard', () => {
  it('renders tool name + input and fires onRespond with the token on Approve', () => {
    const responses: ToolApprovalResponse[] = [];
    render(<ToolApprovalCard approval={approval} onRespond={(r) => responses.push(r)} />);
    expect(screen.getByText('deleteFile')).toBeTruthy();
    expect(screen.getByText(/\/tmp\/x/)).toBeTruthy();
    fireEvent.click(screen.getByText('Approve'));
    expect(responses).toEqual([{ approvalId: 'a1', approved: true, token: 'tok-1' }]);
  });

  it('Deny fires approved: false (token still attached)', () => {
    const responses: ToolApprovalResponse[] = [];
    render(<ToolApprovalCard approval={approval} onRespond={(r) => responses.push(r)} />);
    fireEvent.click(screen.getByText('Deny'));
    expect(responses).toEqual([{ approvalId: 'a1', approved: false, token: 'tok-1' }]);
  });

  it('omits the token when the request carries none', () => {
    const { token: _token, ...tokenless } = approval;
    const responses: ToolApprovalResponse[] = [];
    render(<ToolApprovalCard approval={tokenless} onRespond={(r) => responses.push(r)} />);
    fireEvent.click(screen.getByText('Approve'));
    expect(responses).toEqual([{ approvalId: 'a1', approved: true }]);
  });

  it('render prop overrides presentation but keeps the wired callbacks', () => {
    const responses: ToolApprovalResponse[] = [];
    render(
      <ToolApprovalCard
        approval={approval}
        onRespond={(r) => responses.push(r)}
        render={({ approval: a, deny }) => (
          <button type="button" onClick={() => deny('too risky')}>
            block {a.toolName}
          </button>
        )}
      />,
    );
    fireEvent.click(screen.getByText('block deleteFile'));
    expect(responses).toEqual([
      { approvalId: 'a1', approved: false, reason: 'too risky', token: 'tok-1' },
    ]);
  });
});

describe('CostBadge', () => {
  it('formats the cost to 4 decimals', () => {
    render(<CostBadge cost={{ costUsd: 0.12345 }} />);
    expect(screen.getByText('$0.1235')).toBeTruthy();
  });

  it('appends cache savings when cacheSavingsUsd > 0', () => {
    render(<CostBadge cost={{ costUsd: 1.5, cacheSavingsUsd: 0.25 }} />);
    expect(screen.getByText('$1.5000 (saved $0.2500)')).toBeTruthy();
  });

  it('hides savings when cacheSavingsUsd is 0 and renders nothing without cost', () => {
    const { container } = render(<CostBadge cost={{ costUsd: 2, cacheSavingsUsd: 0 }} />);
    expect(container.textContent).toBe('$2.0000');
    const { container: empty } = render(<CostBadge cost={undefined} />);
    expect(empty.textContent).toBe('');
  });

  it('format prop overrides the default rendering', () => {
    render(<CostBadge cost={{ costUsd: 0.5 }} format={(c) => <em>{c.costUsd} USD</em>} />);
    expect(screen.getByText('0.5 USD')).toBeTruthy();
  });
});
