import { useState, type FormEvent, type KeyboardEvent } from "react";

export function Composer({
  onSubmit,
  disabled,
  placeholder = "Pregunta a SYNCO",
}: {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const t = value.trim();
    if (!t || disabled) return;
    onSubmit(t);
    setValue("");
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mx-auto w-full max-w-3xl rounded-2xl border border-zinc-800 bg-zinc-950/80 px-4 py-3 shadow-xl backdrop-blur"
    >
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        rows={1}
        placeholder={placeholder}
        disabled={disabled}
        className="block w-full resize-none bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
      />
      <div className="flex justify-end pt-2">
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          className="rounded-full bg-zinc-100 px-4 py-1.5 text-xs font-medium text-zinc-900 transition hover:bg-white disabled:opacity-40"
        >
          Enviar
        </button>
      </div>
    </form>
  );
}
