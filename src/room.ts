// The room: who is online, offers between devices and their transfers. Pure state; the server
// passes sockets in as `send` functions and stores file bytes itself (src/spool.ts).

export type DeviceKind = "phone" | "tablet" | "laptop" | "desktop";
const KINDS: DeviceKind[] = ["phone", "tablet", "laptop", "desktop"];

export const LIMITS = {
  nameChars: 40,
  fileNameChars: 200,
  filesPerOffer: 200,
  textChars: 100_000,
  /** An offer nobody answers expires after this. */
  offerTtlMs: 10 * 60_000,
  /** Received files stay downloadable this long after the transfer ends. */
  keepMs: 60 * 60_000,
  /** A peer that left stays in the list as offline this long, so a phone that locks comes back. */
  offlineMs: 2 * 60_000,
};

export interface PeerView {
  id: string;
  name: string;
  kind: DeviceKind;
  online: boolean;
}

export type FileState = "waiting" | "uploading" | "ready" | "failed";
export type TransferState = "offered" | "accepted" | "declined" | "cancelled" | "expired" | "done" | "failed";

export interface FileEntry {
  idx: number;
  name: string;
  size: number;
  type: string;
  received: number;
  state: FileState;
  /** Download key, given to the receiver only. */
  key: string;
}

export interface Transfer {
  id: string;
  from: string;
  to: string;
  files: FileEntry[];
  state: TransferState;
  createdAt: number;
  endedAt?: number;
  error?: string;
}

/** What one side sees of a transfer: the sender never gets the download keys. */
export interface TransferView {
  id: string;
  from: string;
  to: string;
  state: TransferState;
  createdAt: number;
  error?: string;
  files: (Omit<FileEntry, "key"> & { url?: string })[];
}

export type ServerMsg =
  | { type: "welcome"; self: PeerView; peers: PeerView[]; transfers: TransferView[] }
  | { type: "peers"; peers: PeerView[] }
  | { type: "transfer"; transfer: TransferView }
  | { type: "text"; id: string; from: string; to: string; text: string; at: number }
  | { type: "error"; code: string; ref?: string }
  | { type: "replaced" };

interface Peer {
  id: string;
  secret: string;
  name: string;
  kind: DeviceKind;
  send?: (msg: ServerMsg) => void;
  socket?: number;
  leftAt?: number;
}

export interface OfferFile {
  name: string;
  size: number;
  type?: string;
}

export class RoomError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const randomId = (bytes = 12) => {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

export function cleanName(name: unknown, max = LIMITS.nameChars): string {
  if (typeof name !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** A file name that cannot climb out of a folder or carry control characters. */
export function cleanFileName(name: unknown): string {
  const base = cleanName(typeof name === "string" ? name.split(/[\\/]/).pop() : "", LIMITS.fileNameChars);
  return base === "" || base === "." || base === ".." ? "file" : base;
}

export class Room {
  private peers = new Map<string, Peer>();
  private transfers = new Map<string, Transfer>();
  private sockets = 0;

  constructor(private now: () => number = Date.now) {}

  /** A socket says who it is. A known id must bring its secret; a new id is registered. */
  join(
    hello: { id?: unknown; secret?: unknown; name?: unknown; kind?: unknown },
    send: (msg: ServerMsg) => void,
  ): { peer: PeerView; socket: number } {
    const id = typeof hello.id === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(hello.id) ? hello.id : null;
    const secret = typeof hello.secret === "string" && hello.secret.length >= 16 ? hello.secret : null;
    if (!id || !secret) throw new RoomError("bad_hello");
    const kind = KINDS.includes(hello.kind as DeviceKind) ? (hello.kind as DeviceKind) : "desktop";
    const name = cleanName(hello.name) || "Device";
    let peer = this.peers.get(id);
    if (peer && peer.secret !== secret) throw new RoomError("bad_secret");
    if (!peer) {
      peer = { id, secret, name, kind };
      this.peers.set(id, peer);
    } else {
      peer.name = name;
      peer.kind = kind;
      if (peer.send) peer.send({ type: "replaced" });
    }
    peer.send = send;
    peer.socket = ++this.sockets;
    peer.leftAt = undefined;
    send({
      type: "welcome",
      self: this.view(peer),
      peers: this.peerViews(id),
      transfers: this.transfersOf(id).map((t) => this.transferView(t, id)),
    });
    this.broadcastPeers();
    return { peer: this.view(peer), socket: peer.socket };
  }

  /** The socket closed. Ignored when a newer socket has replaced it. */
  leave(id: string, socket: number): void {
    const peer = this.peers.get(id);
    if (!peer || peer.socket !== socket) return;
    peer.send = undefined;
    peer.leftAt = this.now();
    this.broadcastPeers();
  }

  /** Checks an HTTP request's peer credentials. */
  auth(id: string | null, secret: string | null): string {
    const peer = id ? this.peers.get(id) : undefined;
    if (!peer || !secret || peer.secret !== secret) throw new RoomError("unauthorized");
    return peer.id;
  }

  rename(id: string, name: unknown): void {
    const peer = this.mustPeer(id);
    const clean = cleanName(name);
    if (!clean) throw new RoomError("bad_name");
    peer.name = clean;
    this.broadcastPeers();
  }

  offer(from: string, to: string, files: OfferFile[]): Transfer {
    this.mustPeer(from);
    const target = this.peers.get(to);
    if (!target || to === from) throw new RoomError("no_such_device");
    if (!target.send) throw new RoomError("device_offline");
    if (!Array.isArray(files) || files.length === 0 || files.length > LIMITS.filesPerOffer) throw new RoomError("bad_files");
    const entries: FileEntry[] = files.map((f, idx) => {
      const size = Number(f?.size);
      if (!Number.isSafeInteger(size) || size < 0) throw new RoomError("bad_files");
      return {
        idx,
        name: cleanFileName(f?.name),
        size,
        type: typeof f?.type === "string" && f.type.length < 120 ? f.type : "",
        received: 0,
        state: "waiting",
        key: randomId(16),
      };
    });
    const t: Transfer = { id: randomId(8), from, to, files: entries, state: "offered", createdAt: this.now() };
    this.transfers.set(t.id, t);
    this.emit(t);
    return t;
  }

  respond(id: string, by: string, accept: boolean): Transfer {
    const t = this.mustTransfer(id);
    if (t.to !== by) throw new RoomError("forbidden");
    if (t.state !== "offered") throw new RoomError("not_offered");
    t.state = accept ? "accepted" : "declined";
    if (!accept) t.endedAt = this.now();
    this.emit(t);
    return t;
  }

  cancel(id: string, by: string): Transfer {
    const t = this.mustTransfer(id);
    if (t.from !== by && t.to !== by) throw new RoomError("forbidden");
    if (t.state === "offered" || t.state === "accepted") {
      t.state = "cancelled";
      t.endedAt = this.now();
      this.emit(t);
    }
    return t;
  }

  /** The sender may upload file `idx` of an accepted transfer. */
  beginUpload(id: string, by: string, idx: number): FileEntry {
    const t = this.mustTransfer(id);
    if (t.from !== by) throw new RoomError("forbidden");
    if (t.state !== "accepted") throw new RoomError("not_accepted");
    const f = t.files[idx];
    if (!f) throw new RoomError("no_such_file");
    if (f.state === "ready" || f.state === "uploading") throw new RoomError("already_sent");
    f.state = "uploading";
    f.received = 0;
    this.emit(t);
    return f;
  }

  progress(id: string, idx: number, received: number): void {
    const t = this.transfers.get(id);
    const f = t?.files[idx];
    if (!t || !f || f.state !== "uploading") return;
    f.received = received;
    this.emit(t);
  }

  fileDone(id: string, idx: number): void {
    const t = this.transfers.get(id);
    const f = t?.files[idx];
    if (!t || !f) return;
    f.state = "ready";
    f.received = f.size;
    if (t.files.every((x) => x.state === "ready")) {
      t.state = "done";
      t.endedAt = this.now();
    }
    this.emit(t);
  }

  /** A file that failed can be sent again; the transfer stays accepted. */
  fileFailed(id: string, idx: number, error: string): void {
    const t = this.transfers.get(id);
    const f = t?.files[idx];
    if (!t || !f) return;
    f.state = "failed";
    t.error = error;
    this.emit(t);
  }

  /** The file behind a receiver's download key. */
  download(key: string): { transfer: Transfer; file: FileEntry } | null {
    for (const t of this.transfers.values()) {
      for (const f of t.files) if (f.key === key && f.state === "ready") return { transfer: t, file: f };
    }
    return null;
  }

  text(from: string, to: string, text: unknown): { id: string; at: number } {
    this.mustPeer(from);
    const target = this.peers.get(to);
    if (!target || to === from) throw new RoomError("no_such_device");
    if (!target.send) throw new RoomError("device_offline");
    if (typeof text !== "string" || !text.trim() || text.length > LIMITS.textChars) throw new RoomError("bad_text");
    const msg = { type: "text" as const, id: randomId(8), from, to, text, at: this.now() };
    target.send(msg);
    this.peers.get(from)?.send?.(msg);
    return { id: msg.id, at: msg.at };
  }

  /** Expires old offers, forgets ended transfers and long-gone peers. Returns transfers to delete files of. */
  sweep(): Transfer[] {
    const now = this.now();
    const gone: Transfer[] = [];
    for (const t of this.transfers.values()) {
      if (t.state === "offered" && now - t.createdAt > LIMITS.offerTtlMs) {
        t.state = "expired";
        t.endedAt = now;
        this.emit(t);
      }
      const ended = t.state !== "offered" && t.state !== "accepted";
      const stale = t.state === "accepted" && now - t.createdAt > 24 * 60 * 60_000;
      if ((ended && t.endedAt !== undefined && now - t.endedAt > LIMITS.keepMs) || stale) {
        this.transfers.delete(t.id);
        gone.push(t);
      }
    }
    let changed = false;
    for (const p of this.peers.values()) {
      if (!p.send && p.leftAt !== undefined && now - p.leftAt > LIMITS.offlineMs && this.transfersOf(p.id).length === 0) {
        this.peers.delete(p.id);
        changed = true;
      }
    }
    if (changed) this.broadcastPeers();
    return gone;
  }

  get(id: string): Transfer | undefined {
    return this.transfers.get(id);
  }

  peerViews(except?: string): PeerView[] {
    const now = this.now();
    return [...this.peers.values()]
      .filter((p) => p.id !== except && (p.send || (p.leftAt !== undefined && now - p.leftAt <= LIMITS.offlineMs)))
      .map((p) => this.view(p))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }

  transferView(t: Transfer, viewer: string): TransferView {
    const receiver = viewer === t.to;
    return {
      id: t.id,
      from: t.from,
      to: t.to,
      state: t.state,
      createdAt: t.createdAt,
      error: t.error,
      files: t.files.map(({ key, ...f }) => ({
        ...f,
        url: receiver && f.state === "ready" ? `api/download/${key}/${encodeURIComponent(f.name)}` : undefined,
      })),
    };
  }

  private view(p: Peer): PeerView {
    return { id: p.id, name: p.name, kind: p.kind, online: !!p.send };
  }

  private transfersOf(id: string): Transfer[] {
    return [...this.transfers.values()].filter((t) => t.from === id || t.to === id);
  }

  private emit(t: Transfer): void {
    for (const id of new Set([t.from, t.to])) {
      this.peers.get(id)?.send?.({ type: "transfer", transfer: this.transferView(t, id) });
    }
  }

  private broadcastPeers(): void {
    for (const p of this.peers.values()) p.send?.({ type: "peers", peers: this.peerViews(p.id) });
  }

  private mustPeer(id: string): Peer {
    const p = this.peers.get(id);
    if (!p) throw new RoomError("unauthorized");
    return p;
  }

  private mustTransfer(id: string): Transfer {
    const t = this.transfers.get(id);
    if (!t) throw new RoomError("no_such_transfer");
    return t;
  }
}
