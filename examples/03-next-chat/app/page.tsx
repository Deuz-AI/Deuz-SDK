'use client';

import { useState } from 'react';
import { ToolApprovalCard, useChat } from '@deuz-sdk/react';

export default function ChatPage() {
  // `api` serves toDeuzStreamResponse output; the hook owns React state only —
  // every chat-state transition is a pure core call under the hood.
  const chat = useChat({ api: '/api/chat' });
  const [input, setInput] = useState('');

  return (
    <main style={{ maxWidth: 640, margin: '2rem auto', fontFamily: 'system-ui' }}>
      <h1>Deuz chat</h1>

      {chat.messages.map((message) => (
        <p key={message.id}>
          <strong>{message.role}: </strong>
          {message.content}
        </p>
      ))}

      {/* The stream PAUSED on a gated tool call. Answering every card
          auto-resumes the run with the signed verdicts attached. */}
      {chat.pendingApprovals.map((approval) => (
        <ToolApprovalCard
          key={approval.approvalId}
          approval={approval}
          onRespond={(response) => void chat.addToolApprovalResponse(response)}
        />
      ))}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const text = input.trim();
          if (!text) return;
          setInput('');
          void chat.sendMessage(text);
        }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask something, or: delete src/old.ts"
          style={{ width: '100%', padding: '0.5rem' }}
        />
      </form>

      <p>
        status: {chat.status}
        {chat.error ? ` — ${chat.error.message}` : ''}
      </p>
    </main>
  );
}
