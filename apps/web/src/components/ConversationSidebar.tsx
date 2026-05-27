import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ConversationSummary, Session } from "@synco/sdk";
import { clearStoredJwt, getBrowserClient } from "../lib/synco.js";

export function ConversationSidebar({ session }: { session: Session }) {
  const orgId = session.organizations[0]?.id;
  const params = useParams({ strict: false }) as { conversationId?: string };
  const activeId = params.conversationId;

  const { data, isLoading } = useQuery({
    queryKey: ["conversations", orgId],
    queryFn: async (): Promise<ConversationSummary[]> => {
      if (!orgId) return [];
      return getBrowserClient().conversations.list(orgId);
    },
    enabled: !!orgId,
  });

  function logout() {
    clearStoredJwt();
    window.location.href = "/login";
  }

  return (
    <aside className="flex h-full w-72 flex-col border-r border-zinc-900 bg-zinc-950/40">
      <div className="px-4 pt-4 pb-3">
        <div className="text-sm font-semibold tracking-tight">SYNCO</div>
        <div className="text-[11px] text-zinc-500">{session.user.email}</div>
      </div>
      <Link
        to="/chat/new"
        className="mx-3 mb-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-center text-xs text-zinc-200 transition hover:bg-zinc-900"
      >
        + Nueva conversación
      </Link>
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {isLoading && <div className="px-2 py-2 text-xs text-zinc-500">Cargando…</div>}
        {(data ?? []).map((c) => (
          <Link
            key={c.id}
            to="/chat/$conversationId"
            params={{ conversationId: c.id }}
            className={`block truncate rounded-lg px-3 py-2 text-xs ${
              activeId === c.id
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            }`}
          >
            {c.title ?? "Sin título"}
          </Link>
        ))}
      </div>
      <button
        onClick={logout}
        className="border-t border-zinc-900 px-4 py-3 text-left text-xs text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
      >
        Cerrar sesión
      </button>
    </aside>
  );
}
