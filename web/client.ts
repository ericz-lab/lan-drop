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
  /**
   * The direct https address of the server on the LAN, when the page found it: file bytes go there
   * instead of through the tunnel. Null sends them to the page's own address.
   */
  bytes: string | null = null;
  /** Called when the direct address stopped answering mid-upload (the device left home). */
  onDirectLost: () => void = () => {};

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

  /**
   * Uploads one file in pieces of at most PIECE bytes (a Cloudflare tunnel refuses a request over
   * 100 MB), each continuing where the last ended. XHR because fetch reports no upload progress.
   */
  upload(transferId: string, idx: number, file: File, progress: (sent: number) => void): { done: Promise<void>; abort(): void } {
    let xhr: XMLHttpRequest | null = null;
    let aborted = false;
    const piece = (offset: number, blob: Blob, base: string) =>
      new Promise<number>((res, rej) => {
        const x = new XMLHttpRequest();
        xhr = x;
        x.open("PUT", new URL(`api/transfers/${transferId}/files/${idx}?offset=${offset}`, base));
        x.setRequestHeader("x-peer-id", this.ident.id);
        x.setRequestHeader("x-peer-secret", this.ident.secret);
        x.upload.onprogress = (e) => progress(offset + e.loaded);
        x.onload = () => {
          let body: { error?: string; received?: number } = {};
          try {
            body = JSON.parse(x.responseText);
          } catch {}
          if (x.status >= 200 && x.status < 300) return res(body.received ?? offset + blob.size);
          rej(new Error(body.error ?? `http_${x.status}`));
        };
        x.onerror = () => rej(new Error("network"));
        x.onabort = () => rej(new Error("aborted"));
        x.send(blob);
      });
    const done = (async () => {
      let offset = 0;
      do {
        if (aborted) throw new Error("aborted");
        const end = Math.min(file.size, offset + PIECE);
        const blob = file.slice(offset, end);
        const direct = this.bytes;
        try {
          offset = await piece(offset, blob, direct ?? location.href);
        } catch (e) {
          // The direct address went away: send this piece again the long way.
          if (!direct || aborted || (e as Error).message !== "network") throw e;
          if (this.bytes === direct) {
            this.bytes = null;
            this.onDirectLost();
          }
          offset = await piece(offset, blob, location.href);
        }
      } while (offset < file.size);
    })();
    return {
      done,
      abort: () => {
        aborted = true;
        xhr?.abort();
      },
    };
  }
}

/** Bytes per upload request. */
export const PIECE = 64 * 1024 * 1024;
