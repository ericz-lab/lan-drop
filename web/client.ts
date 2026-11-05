// The page's side of the room: one socket that reconnects, file uploads with progress.
import type { PeerView, ServerMsg, TransferView } from "../src/room.ts";
import type { Identity } from "./device.ts";

export type ConnState = "connecting" | "online" | "reconnecting" | "pin" | "replaced";

export type ClientMsg = ServerMsg | { type: "offered"; ref: string; id: string } | { type: "pong" };

export interface Events {
  state(s: ConnState, detail?: string): void;
  welcome(self: PeerView, peers: PeerView[], transfers: TransferView[]): void;
  peers(peers: PeerView[]): void;
  transfer(t: TransferView): void;
  text(m: Extract<ServerMsg, { type: "text" }>): void;
  error(code: string, ref?: string): void;
}

export class Client {
  private ws: WebSocket | null = null;
  private tries = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private refs = 0;
  private waiting = new Map<string, { res: (id: string) => void; rej: (e: Error) => void }>();
  pin = "";
  stopped = false;

  constructor(
    private ident: Identity,
    private kind: string,
    private on: Events,
  ) {}

  connect(): void {
    this.stopped = false;
    if (this.timer) clearTimeout(this.timer);
    const url = new URL("api/ws", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    this.ws = ws;
    this.on.state(this.tries === 0 ? "connecting" : "reconnecting");
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", id: this.ident.id, secret: this.ident.secret, name: this.ident.name, kind: this.kind, pin: this.pin }));
    };
    ws.onmessage = (e) => this.handle(JSON.parse(String(e.data)) as ClientMsg);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (this.ping) clearInterval(this.ping);
      for (const w of this.waiting.values()) w.rej(new Error("offline"));
      this.waiting.clear();
      if (this.stopped) return;
      // 1, 2, 4, 8 s, then every 8 s.
      const delay = Math.min(8000, 1000 * 2 ** this.tries++);
      this.on.state("reconnecting");
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  /** Reconnect at once (the page came back to the foreground, the network changed). */
  wake(): void {
    if (this.stopped) return;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.tries = 0;
      this.connect();
    }
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private handle(m: ClientMsg): void {
    switch (m.type) {
      case "welcome":
        this.tries = 0;
        this.on.state("online");
        this.on.welcome(m.self, m.peers, m.transfers);
        if (this.ping) clearInterval(this.ping);
        this.ping = setInterval(() => this.send({ type: "ping" }), 25_000);
        break;
      case "peers":
        this.on.peers(m.peers);
        break;
      case "transfer":
        this.on.transfer(m.transfer);
        break;
      case "text":
        this.on.text(m);
        break;
      case "offered":
        this.waiting.get(m.ref)?.res(m.id);
        this.waiting.delete(m.ref);
        break;
      case "replaced":
        this.stopped = true;
        this.on.state("replaced");
        break;
      case "error":
        if (m.code === "pin_wrong" || m.code === "pin_locked") {
          this.stopped = true;
          this.on.state("pin", m.code);
          this.ws?.close();
          return;
        }
        if (m.ref && this.waiting.has(m.ref)) {
          this.waiting.get(m.ref)!.rej(new Error(m.code));
          this.waiting.delete(m.ref);
        }
        this.on.error(m.code, m.ref);
        break;
    }
  }

  send(m: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  rename(name: string): void {
    this.ident.name = name;
    this.send({ type: "rename", name });
  }

  offer(to: string, files: File[]): Promise<string> {
    const ref = `r${++this.refs}`;
    return new Promise((res, rej) => {
      this.waiting.set(ref, { res, rej });
      const ok = this.send({ type: "offer", ref, to, files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })) });
      if (!ok) {
        this.waiting.delete(ref);
        rej(new Error("offline"));
      }
    });
  }

  respond(id: string, accept: boolean): void {
    this.send({ type: "respond", id, accept });
  }

  cancel(id: string): void {
    this.send({ type: "cancel", id });
  }

  text(to: string, text: string): boolean {
    return this.send({ type: "text", to, text });
  }

  /** Uploads one file; XHR because fetch reports no upload progress. */
  upload(transferId: string, idx: number, file: File, progress: (sent: number) => void): { done: Promise<void>; abort(): void } {
    const xhr = new XMLHttpRequest();
    const done = new Promise<void>((res, rej) => {
      xhr.open("PUT", new URL(`api/transfers/${transferId}/files/${idx}`, location.href));
      xhr.setRequestHeader("x-peer-id", this.ident.id);
      xhr.setRequestHeader("x-peer-secret", this.ident.secret);
      xhr.upload.onprogress = (e) => progress(e.loaded);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return res();
        let code = `http_${xhr.status}`;
        try {
          code = JSON.parse(xhr.responseText).error ?? code;
        } catch {}
        rej(new Error(code));
      };
      xhr.onerror = () => rej(new Error("network"));
      xhr.onabort = () => rej(new Error("aborted"));
      xhr.send(file);
    });
    return { done, abort: () => xhr.abort() };
  }
}
