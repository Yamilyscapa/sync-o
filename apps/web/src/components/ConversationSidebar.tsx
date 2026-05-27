import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ConversationSummary, Session } from "@synco/sdk";
import { clearStoredJwt, getBrowserClient } from "../lib/synco.js";

export function ConversationSidebar({
  session,
  open = false,
  onClose,
}: {
  session: Session;
  open?: boolean;
  onClose?: () => void;
}) {
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
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex h-full w-72 flex-col border-r border-zinc-900 bg-zinc-950 transition-transform duration-200 ease-out md:static md:z-auto md:translate-x-0 md:bg-zinc-950/40 ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="flex items-start justify-between px-4 pt-4 pb-3">
        <div>
          <div className="text-sm font-semibold tracking-tight">SYNCO</div>
          <div className="text-[11px] text-zinc-500">{session.user.email}</div>
        </div>
        <button
          aria-label="Cerrar menú"
          onClick={onClose}
          className="-mr-1 rounded-md p-1 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 md:hidden"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <Link
        to="/chat/new"
        onClick={onClose}
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
            onClick={onClose}
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
