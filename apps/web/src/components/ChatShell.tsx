import { useEffect, useRef, useState } from "react";
import type {
  AgentRunOutput,
  ApprovalDecision,
  PendingApproval,
  Session,
} from "@synco/sdk";
import { getBrowserClient } from "../lib/synco.js";
import { Composer } from "./Composer.js";
import { MessageBubble, type ChatMessage } from "./MessageBubble.js";
import { ApprovalCard } from "./ApprovalCard.js";
import { Mascot } from "./Mascot.js";

export type ChatShellProps = {
  session: Session;
  initial?: { messages: ChatMessage[]; conversationId: string | null };
  onConversationCreated?: (conversationId: string) => void;
};

export function ChatShell({ session, initial, onConversationCreated }: ChatShellProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(initial?.messages ?? []);
  const [conversationId, setConversationId] = useState<string | null>(
    initial?.conversationId ?? null,
  );
  const [pending, setPending] = useState<{
    approvals: PendingApproval[];
    serializedState: string;
  } | null>(null);
  const [streaming, setStreaming] = useState(false);
  const assistantIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerHomeRef = useRef<HTMLDivElement>(null);
  const orgId = session.organizations[0]?.id;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, pending]);

  function appendUser(text: string): string {
    const id = crypto.randomUUID();
    setMessages((m) => [...m, { id, role: "user", content: text }]);
    return id;
  }

  function beginAssistant(): string {
    const id = crypto.randomUUID();
    assistantIdRef.current = id;
    setMessages((m) => [...m, { id, role: "assistant", content: "", streaming: true }]);
    return id;
  }

  function appendToken(delta: string) {
    const id = assistantIdRef.current;
    if (!id) return;
    setMessages((m) =>
      m.map((msg) =>
        msg.id === id && msg.role === "assistant"
          ? { ...msg, content: msg.content + delta }
          : msg,
      ),
    );
  }

  function finishAssistant() {
    const id = assistantIdRef.current;
    if (!id) return;
    setMessages((m) =>
      m.map((msg) =>
        msg.id === id && msg.role === "assistant"
          ? { ...msg, streaming: false }
          : msg,
      ),
    );
    assistantIdRef.current = null;
  }

  async function send(text: string) {
    if (!orgId) return;
    appendUser(text);
    beginAssistant();
    setStreaming(true);
    const client = getBrowserClient();
    try {
      await client.agent.run(
        { input: text, organizationId: orgId, conversationId: conversationId ?? undefined },
        {
          onToken: (d) => appendToken(d),
          onApprovalRequired: (approvals, serializedState, cid) => {
            setPending({ approvals, serializedState });
            if (!conversationId) {
              setConversationId(cid);
              onConversationCreated?.(cid);
            }
          },
          onDone: (result: AgentRunOutput) => {
            finishAssistant();
            if (result.kind === "final" && !conversationId) {
              setConversationId(result.conversationId);
              onConversationCreated?.(result.conversationId);
            }
            if (result.kind === "awaiting_approval" && !conversationId) {
              setConversationId(result.conversationId);
              onConversationCreated?.(result.conversationId);
            }
          },
          onError: (m) => {
            appendToken(`\n\n_Error: ${m}_`);
            finishAssistant();
          },
        },
      );
    } finally {
      setStreaming(false);
    }
  }

  async function submitDecisions(decisions: ApprovalDecision[]) {
    if (!pending || !conversationId) return;
    const serializedState = pending.serializedState;
    setPending(null);
    beginAssistant();
    setStreaming(true);
    const client = getBrowserClient();
    try {
      await client.agent.resume(
        { serializedState, conversationId, decisions },
        {
          onToken: (d) => appendToken(d),
          onApprovalRequired: (approvals, newState) => {
            setPending({ approvals, serializedState: newState });
          },
          onDone: () => finishAssistant(),
          onError: (m) => {
            appendToken(`\n\n_Error: ${m}_`);
            finishAssistant();
          },
        },
      );
    } finally {
      setStreaming(false);
    }
  }

  const empty = messages.length === 0 && !pending;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {empty ? (
          <div className="flex h-full items-center justify-center px-6">
            <div className="text-center">
              <h2 className="mb-8 text-3xl font-light tracking-tight text-zinc-200">
                ¿En qué te ayudo hoy?
              </h2>
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-8">
            {messages.map((m) => (
              <MessageBubble key={m.id} msg={m} />
            ))}
            {pending && (
              <ApprovalCard
                approvals={pending.approvals}
                onSubmit={submitDecisions}
                disabled={streaming}
              />
            )}
          </div>
        )}
      </div>
      <div className="px-6 pb-6">
        <div ref={composerHomeRef} className="relative mx-auto w-full max-w-3xl">
          <Mascot homeRef={composerHomeRef} />
          <Composer onSubmit={send} disabled={streaming || !!pending} />
        </div>
      </div>
    </div>
  );
}
