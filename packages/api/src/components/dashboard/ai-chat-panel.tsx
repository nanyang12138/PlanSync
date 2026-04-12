'use client';

import { useState, useRef, useEffect } from 'react';
import { Send, Sparkles, Loader2, AlertCircle } from 'lucide-react';

type Message = { role: 'user' | 'assistant'; content: string };

type AiChatPanelProps = {
  projectId: string;
};

function MessageContent({ content }: { content: string }) {
  const parts = content.split(/(```[\s\S]*?```)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('```')) {
          const code = part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
          return (
            <pre
              key={i}
              className="mt-1.5 rounded p-2 bg-slate-900 text-slate-100 text-[10px] font-mono overflow-x-auto whitespace-pre"
            >
              {code}
            </pre>
          );
        }
        return (
          <span key={i}>
            {part.split('\n\n').map((para, j) => (
              <p key={j} className={j > 0 ? 'mt-1.5' : ''}>
                {para}
              </p>
            ))}
          </span>
        );
      })}
    </>
  );
}

export function AiChatPanel({ projectId }: AiChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [aiUnavailable, setAiUnavailable] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = { role: 'user', content: text };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch(`/api/projects/${projectId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: messages.slice(-8) }),
      });

      if (res.status === 503) {
        setAiUnavailable(true);
        return;
      }

      const data = await res.json();
      setMessages([
        ...nextMessages,
        { role: 'assistant', content: data.reply ?? 'No response from PlanSync AI.' },
      ]);
    } catch {
      setMessages([
        ...nextMessages,
        { role: 'assistant', content: 'Network error. Please try again.' },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (aiUnavailable) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 p-6 text-center">
        <AlertCircle className="h-8 w-8 text-amber-400" />
        <p className="text-sm font-medium text-slate-700">PlanSync AI not configured</p>
        <p className="text-xs text-slate-500 max-w-[200px]">
          Set <code className="font-mono">LLM_API_KEY</code> or{' '}
          <code className="font-mono">ANTHROPIC_API_KEY</code> in your server environment.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-2 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center gap-3 pt-6 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-violet-500">
              <Sparkles className="h-4.5 w-4.5 text-white" />
            </div>
            <p className="text-xs text-slate-500">Hi, I&apos;m PlanSync AI. Try asking:</p>
            <div className="w-full space-y-1">
              {[
                'What should I work on today?',
                'Explain this drift alert',
                'What is the goal of the current plan?',
              ].map((hint) => (
                <button
                  key={hint}
                  onClick={() => {
                    setInput(hint);
                    textareaRef.current?.focus();
                  }}
                  className="block w-full text-xs text-left text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded px-3 py-1.5 transition-colors"
                >
                  {hint}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[88%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white rounded-br-sm'
                  : 'bg-slate-100 text-slate-700 rounded-bl-sm'
              }`}
            >
              {msg.role === 'assistant' ? <MessageContent content={msg.content} /> : msg.content}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-slate-100 rounded-xl rounded-bl-sm px-3 py-2">
              <Loader2 className="h-3.5 w-3.5 text-slate-400 animate-spin" />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input — pinned at bottom */}
      <div className="border-t border-slate-100 p-3 flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about plans, tasks, or drift..."
          rows={1}
          className="flex-1 resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 leading-relaxed"
          style={{ maxHeight: '80px', overflowY: 'auto' }}
          disabled={loading}
        />
        <button
          onClick={send}
          disabled={!input.trim() || loading}
          className="shrink-0 flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
