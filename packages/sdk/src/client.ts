import type {
  AgentResumeInput,
  AgentRunInput,
  AgentRunOutput,
  ApprovalDecision,
  ConversationDetail,
  ConversationSummary,
  Session,
  StreamEvent,
  StreamHandlers,
} from "./types.js";

export type SyncoClientOptions = {
  baseUrl: string;
  getToken?: () => Promise<string | null> | string | null;
  fetchImpl?: typeof fetch;
};

export class SyncoClient {
  private baseUrl: string;
  private getToken: () => Promise<string | null>;
  private fetchImpl: typeof fetch;

  constructor(opts: SyncoClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    const g = opts.getToken;
    this.getToken = async () => (g ? (await g()) ?? null : null);
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const h: Record<string, string> = { "content-type": "application/json", ...extra };
    const t = await this.getToken();
    if (t) h["authorization"] = `Bearer ${t}`;
    return h;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  agent = {
    run: async (body: AgentRunInput, handlers: StreamHandlers): Promise<void> => {
      await this.openStream("/agent/run/stream", body, handlers);
    },
    resume: async (body: AgentResumeInput, handlers: StreamHandlers): Promise<void> => {
      await this.openStream("/agent/run/resume/stream", body, handlers);
    },
    runBuffered: async (body: AgentRunInput): Promise<AgentRunOutput> => {
      const r = await this.fetchImpl(this.url("/agent/run"), {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`agent.run failed: ${r.status} ${await r.text()}`);
      const json = (await r.json()) as { result: AgentRunOutput };
      return json.result;
    },
    resumeBuffered: async (body: AgentResumeInput): Promise<AgentRunOutput> => {
      const r = await this.fetchImpl(this.url("/agent/run/resume"), {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`agent.resume failed: ${r.status} ${await r.text()}`);
      const json = (await r.json()) as { result: AgentRunOutput };
      return json.result;
    },
  };

  conversations = {
    list: async (organizationId: string): Promise<ConversationSummary[]> => {
      const q = new URLSearchParams({ organizationId }).toString();
      const r = await this.fetchImpl(this.url(`/conversations?${q}`), {
        headers: await this.headers(),
      });
      if (!r.ok) throw new Error(`conversations.list failed: ${r.status}`);
      const json = (await r.json()) as { conversations: ConversationSummary[] };
      return json.conversations;
    },
    get: async (id: string, organizationId: string): Promise<ConversationDetail> => {
      const q = new URLSearchParams({ organizationId }).toString();
      const r = await this.fetchImpl(this.url(`/conversations/${id}?${q}`), {
        headers: await this.headers(),
      });
      if (!r.ok) throw new Error(`conversations.get failed: ${r.status}`);
      const json = (await r.json()) as { conversation: ConversationDetail };
      return json.conversation;
    },
  };

  me = {
    get: async (): Promise<Session | null> => {
      const r = await this.fetchImpl(this.url("/me"), {
        headers: await this.headers(),
      });
      if (r.status === 401) return null;
      if (!r.ok) throw new Error(`me.get failed: ${r.status}`);
      return (await r.json()) as Session;
    },
  };

  private async openStream(
    path: string,
    body: unknown,
    handlers: StreamHandlers,
  ): Promise<void> {
    const r = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: await this.headers({ accept: "text/event-stream" }),
      body: JSON.stringify(body),
    });
    if (!r.ok || !r.body) {
      const text = r.body ? await r.text() : "";
      handlers.onError?.(`stream failed: ${r.status} ${text}`);
      return;
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        this.dispatchSSE(chunk, handlers);
      }
    }
  }

  private dispatchSSE(chunk: string, handlers: StreamHandlers): void {
    const lines = chunk.split("\n");
    let event = "message";
    const dataLines: string[] = [];
    for (const ln of lines) {
      if (ln.startsWith("event:")) event = ln.slice(6).trim();
      else if (ln.startsWith("data:")) dataLines.push(ln.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    let parsed: StreamEvent;
    try {
      parsed = { type: event, ...JSON.parse(data) } as StreamEvent;
    } catch {
      return;
    }
    switch (parsed.type) {
      case "token":
        handlers.onToken?.(parsed.delta);
        break;
      case "tool_call":
        handlers.onToolCall?.(parsed.toolName, parsed.arguments);
        break;
      case "tool_result":
        handlers.onToolResult?.(parsed.toolName, parsed.output);
        break;
      case "approval_required":
        handlers.onApprovalRequired?.(
          parsed.approvals,
          parsed.serializedState,
          parsed.conversationId,
        );
        break;
      case "done":
        handlers.onDone?.(parsed.result);
        break;
      case "error":
        handlers.onError?.(parsed.message);
        break;
    }
  }
}

export const createSyncoClient = (opts: SyncoClientOptions): SyncoClient =>
  new SyncoClient(opts);
