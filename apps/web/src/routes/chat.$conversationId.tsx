import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ConversationDetail, ConversationMessage } from "@synco/sdk";
import { ChatLayout } from "../components/ChatLayout.js";
import { ChatShell } from "../components/ChatShell.js";
import type { ChatMessage } from "../components/MessageBubble.js";
import { getBrowserClient, getStoredJwt } from "../lib/synco.js";

export const Route = createFileRoute("/chat/$conversationId")({
  loader: async ({ params }) => {
    if (!getStoredJwt()) throw redirect({ to: "/login" });
    const client = getBrowserClient();
    const session = await client.me.get();
    if (!session) throw redirect({ to: "/login" });
    const orgId = session.organizations[0]?.id;
    if (!orgId) throw new Error("no organization");
    const conversation = await client.conversations.get(params.conversationId, orgId);
    return { session, conversation };
  },
  component: ChatPage,
});

function ChatPage() {
  const { session, conversation } = Route.useLoaderData() as {
    session: any;
    conversation: ConversationDetail;
  };
  const initialMessages: ChatMessage[] = conversation.messages
    .map((m: ConversationMessage): ChatMessage | null => {
      const p: any = m.payload;
      if (m.role === "user") {
        const text = extractText(p);
        if (!text) return null;
        return { id: `${m.seq}`, role: "user", content: text };
      }
      if (m.role === "assistant") {
        const text = extractText(p);
        if (!text) return null;
        return { id: `${m.seq}`, role: "assistant", content: text };
      }
      if (m.role === "tool" && p?.type === "function_call") {
        return {
          id: `${m.seq}`,
          role: "tool",
          toolName: p.name ?? "tool",
          args: p.arguments,
        };
      }
      return null;
    })
    .filter((x: ChatMessage | null): x is ChatMessage => x !== null);

  return (
    <ChatLayout session={session}>
      <ChatShell
        key={conversation.id}
        session={session}
        initial={{ messages: initialMessages, conversationId: conversation.id }}
      />
    </ChatLayout>
  );
}

function extractText(payload: any): string | null {
  if (!payload) return null;
  if (typeof payload === "string") return payload;
  if (typeof payload.content === "string") return payload.content;
  if (Array.isArray(payload.content)) {
    return payload.content
      .map((c: any) => (typeof c === "string" ? c : c?.text ?? ""))
      .filter(Boolean)
      .join("");
  }
  return null;
}
