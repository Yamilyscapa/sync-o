import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ChatShell } from "../components/ChatShell.js";
import { ConversationSidebar } from "../components/ConversationSidebar.js";
import { getBrowserClient, getStoredJwt } from "../lib/synco.js";

export const Route = createFileRoute("/chat/new")({
  loader: async () => {
    if (!getStoredJwt()) throw redirect({ to: "/login" });
    const session = await getBrowserClient().me.get();
    if (!session) throw redirect({ to: "/login" });
    return { session };
  },
  component: NewChatPage,
});

function NewChatPage() {
  const { session } = Route.useLoaderData();
  const navigate = useNavigate();
  return (
    <div className="flex h-screen w-full">
      <ConversationSidebar session={session} />
      <ChatShell
        session={session}
        onConversationCreated={(id) =>
          navigate({ to: "/chat/$conversationId", params: { conversationId: id } })
        }
      />
    </div>
  );
}
