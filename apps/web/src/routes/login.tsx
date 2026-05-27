import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { getSupabaseBrowser } from "../lib/supabase.js";
import { setStoredJwt } from "../lib/synco.js";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const supabase = getSupabaseBrowser();
      const { data, error: err } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (err || !data.session) {
        setError(err?.message ?? "No se pudo iniciar sesión");
        return;
      }
      setStoredJwt(data.session.access_token);
      navigate({ to: "/chat/new" });
    } catch (e: any) {
      setError(e?.message ?? "Error inesperado");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950/60 p-8 shadow-xl"
      >
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">SYNCO</h1>
        <p className="mb-6 text-sm text-zinc-400">Inicia sesión para continuar</p>
        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-zinc-400">Correo</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-600"
            placeholder="tucorreo@ejemplo.com"
          />
        </label>
        <label className="mb-5 block">
          <span className="mb-1 block text-xs text-zinc-400">Contraseña</span>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-600"
          />
        </label>
        {error && (
          <p className="mb-4 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition hover:bg-white disabled:opacity-50"
        >
          {loading ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </div>
  );
}
