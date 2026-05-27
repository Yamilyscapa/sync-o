import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@synco/sdk";
import { ConversationSidebar } from "./ConversationSidebar.js";

export function ChatLayout({
  session,
  children,
}: {
  session: Session;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="relative flex h-screen w-full">
      <ConversationSidebar
        session={session}
        open={open}
        onClose={() => setOpen(false)}
      />
      {open && (
        <button
          aria-label="Cerrar menú"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
        />
      )}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-zinc-900 px-3 py-2 md:hidden">
          <button
            aria-label="Abrir menú"
            onClick={() => setOpen(true)}
            className="rounded-md p-2 text-zinc-300 hover:bg-zinc-900"
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
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <span className="text-sm font-semibold tracking-tight">SYNCO</span>
        </div>
        {children}
      </div>
    </div>
  );
}
