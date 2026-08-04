import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatMessage, TypingIndicator, type Message } from './ChatMessage.tsx';
import { sendAgentMessage } from '../../api.ts';

interface Props {
  session: string;
}

const WELCOME: Message = {
  id: 'welcome',
  role: 'bot',
  content:
    'Hi! I\'m your CloudFuze migration agent. I can help you migrate Copilot Studio agents, run flows, check status, or answer questions about your migration. What would you like to do?',
  ts: Date.now(),
  quickReplies: ['Start migration', 'Check status', 'What can you do?'],
};

export function AgentChat({ session }: Props) {
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typing]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      const userMsg: Message = {
        id: `u-${Date.now()}`,
        role: 'user',
        content: trimmed,
        ts: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setInput('');
      setTyping(true);

      try {
        const reply = await sendAgentMessage(session, trimmed);
        const botMsg: Message = {
          id: `b-${Date.now()}`,
          role: 'bot',
          content: reply.text,
          ts: Date.now(),
          quickReplies: reply.quickReplies,
        };
        setMessages((prev) => [...prev, botMsg]);
      } catch {
        const errMsg: Message = {
          id: `e-${Date.now()}`,
          role: 'system',
          content: 'Agent unavailable. Please try again.',
          ts: Date.now(),
        };
        setMessages((prev) => [...prev, errMsg]);
      } finally {
        setTyping(false);
      }
    },
    [session],
  );

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const clearChat = () => {
    setMessages([WELCOME]);
    setInput('');
    inputRef.current?.focus();
  };

  return (
    <div className="agent-chat">
      {/* Header */}
      <div className="agent-chat-header">
        <div className="agent-chat-title">
          <div className="agent-avatar-sm">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
              <path d="M12 2a4 4 0 014 4v2H8V6a4 4 0 014-4z"/>
              <rect x="4" y="8" width="16" height="12" rx="2"/>
              <circle cx="9" cy="14" r="1.5" fill="white" stroke="none"/>
              <circle cx="15" cy="14" r="1.5" fill="white" stroke="none"/>
            </svg>
          </div>
          <span>Migration Agent</span>
          <span className="agent-online-dot" />
        </div>
        <button className="agent-clear-btn" onClick={clearChat} title="Clear chat">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10"/>
            <path d="M3.51 15a9 9 0 102.13-9.36L1 10"/>
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div className="agent-messages">
        {messages.map((m) => (
          <ChatMessage key={m.id} msg={m} onQuickReply={(t) => send(t)} />
        ))}
        {typing && <TypingIndicator />}
        <div ref={endRef} />
      </div>

      {/* Input */}
      <div className="agent-input-bar">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Ask me anything or describe what you need..."
          className="agent-input"
          disabled={typing}
        />
        <button
          className="agent-send-btn"
          onClick={() => send(input)}
          disabled={!input.trim() || typing}
          title="Send"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
