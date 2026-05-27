import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type ChatMessage =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; content: string; streaming?: boolean }
  | { id: string; role: "tool"; toolName: string; args?: string };

export function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-zinc-800 px-4 py-2.5 text-sm text-zinc-100">
          {msg.content}
        </div>
      </div>
    );
  }
  if (msg.role === "tool") {
    return (
      <div className="flex">
        <span className="rounded-full border border-zinc-800 bg-zinc-950 px-3 py-1 text-xs text-zinc-400">
          🔧 {msg.toolName}
        </span>
      </div>
    );
  }
  return (
    <div className="md-body text-sm text-zinc-100">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
      {msg.streaming && <span className="stream-cursor" />}
    </div>
  );
}
