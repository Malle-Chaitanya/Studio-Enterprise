import { useMemo } from 'react';

export type MessageRole = 'user' | 'bot' | 'system' | 'progress';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  ts: number;
  quickReplies?: string[];
}

interface Props {
  msg: Message;
  onQuickReply?: (text: string) => void;
}

function BotAvatar() {
  return (
    <div className="chat-avatar bot-avatar">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
        <path d="M12 2a4 4 0 014 4v2H8V6a4 4 0 014-4z"/>
        <rect x="4" y="8" width="16" height="12" rx="2"/>
        <circle cx="9" cy="14" r="1.5" fill="white" stroke="none"/>
        <circle cx="15" cy="14" r="1.5" fill="white" stroke="none"/>
      </svg>
    </div>
  );
}

function UserAvatar() {
  return <div className="chat-avatar user-avatar">U</div>;
}

export function ChatMessage({ msg, onQuickReply }: Props) {
  const time = useMemo(() => {
    const d = new Date(msg.ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, [msg.ts]);

  if (msg.role === 'progress') {
    return (
      <div className="chat-progress">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span>{msg.content}</span>
      </div>
    );
  }

  if (msg.role === 'system') {
    return <div className="chat-system">{msg.content}</div>;
  }

  return (
    <div className={`chat-row ${msg.role}`}>
      {msg.role === 'bot' && <BotAvatar />}
      <div className="chat-bubble-wrap">
        <div className={`chat-bubble ${msg.role}`}>
          <span className="chat-text">{msg.content}</span>
          <span className="chat-time">{time}</span>
        </div>
        {msg.quickReplies && msg.quickReplies.length > 0 && (
          <div className="quick-replies">
            {msg.quickReplies.map((r) => (
              <button key={r} className="quick-reply-btn" onClick={() => onQuickReply?.(r)}>
                {r}
              </button>
            ))}
          </div>
        )}
      </div>
      {msg.role === 'user' && <UserAvatar />}
    </div>
  );
}

export function TypingIndicator() {
  return (
    <div className="chat-row bot">
      <BotAvatar />
      <div className="chat-bubble bot typing-bubble">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
    </div>
  );
}
