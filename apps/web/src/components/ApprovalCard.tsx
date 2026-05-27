import { useState } from "react";
import type { PendingApproval } from "@synco/sdk";

export type ApprovalDecisionsUI = {
  toolName: string;
  approved: boolean;
  rejectionMessage?: string;
};

export function ApprovalCard({
  approvals,
  onSubmit,
  disabled,
}: {
  approvals: PendingApproval[];
  onSubmit: (decisions: ApprovalDecisionsUI[]) => void;
  disabled?: boolean;
}) {
  const [rejectionMessages, setRejectionMessages] = useState<Record<number, string>>({});
  const [showRejectFor, setShowRejectFor] = useState<number | null>(null);

  function approve(idx: number) {
    onSubmit(
      approvals.map((a, i) => ({
        toolName: a.toolName,
        approved: i === idx,
        rejectionMessage: i === idx ? undefined : rejectionMessages[i],
      })),
    );
  }

  function reject(idx: number) {
    const msg = rejectionMessages[idx];
    onSubmit(
      approvals.map((a, i) => ({
        toolName: a.toolName,
        approved: false,
        rejectionMessage: i === idx ? msg : rejectionMessages[i],
      })),
    );
  }

  function approveAll() {
    onSubmit(approvals.map((a) => ({ toolName: a.toolName, approved: true })));
  }

  return (
    <div className="space-y-3">
      {approvals.map((a, i) => (
        <div
          key={i}
          className="rounded-2xl border border-amber-900/40 bg-amber-950/20 p-4"
        >
          <div className="mb-1 text-[10px] uppercase tracking-wider text-amber-300/80">
            Confirmación requerida — {a.toolName}
          </div>
          <p className="mb-3 text-sm text-zinc-100">{a.preview}</p>
          {showRejectFor === i && (
            <textarea
              value={rejectionMessages[i] ?? ""}
              onChange={(e) =>
                setRejectionMessages((m) => ({ ...m, [i]: e.target.value }))
              }
              placeholder="¿Qué quieres cambiar? (opcional)"
              rows={2}
              className="mb-2 w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-100 outline-none focus:border-zinc-600"
            />
          )}
          <div className="flex gap-2">
            <button
              disabled={disabled}
              onClick={() => approve(i)}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              Aprobar
            </button>
            {showRejectFor === i ? (
              <button
                disabled={disabled}
                onClick={() => reject(i)}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-500 disabled:opacity-50"
              >
                Rechazar
              </button>
            ) : (
              <button
                disabled={disabled}
                onClick={() => setShowRejectFor(i)}
                className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-900 disabled:opacity-50"
              >
                Rechazar…
              </button>
            )}
          </div>
        </div>
      ))}
      {approvals.length > 1 && (
        <button
          disabled={disabled}
          onClick={approveAll}
          className="text-xs text-zinc-400 underline-offset-2 hover:underline disabled:opacity-50"
        >
          Aprobar todas
        </button>
      )}
    </div>
  );
}
