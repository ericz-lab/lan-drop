// The HTTP and WebSocket handlers: the room over a socket, uploads into the spool, downloads out.
import type { Server, ServerWebSocket } from "bun";
import { isLoopback, isPrivateOrLoopback, joinUrls } from "./net.ts";
import { Room, RoomError, type ServerMsg } from "./room.ts";
import { Spool } from "./spool.ts";

export interface Options {
  port: number;
  spoolDir: string;
  /** A room PIN for devices that are not this machine; empty for none. */
  pin?: string;
  /** Overrides the join URLs shown (comma-separated). */
  publicUrl?: string;
  now?: () => number;
}

interface SocketData {
  ip: string;
  peer?: string;
  socket?: number;
}

/** Five wrong PINs from one address lock it out for a minute. */
class PinGate {
  private fails = new Map<string, { n: number; until: number }>();
  constructor(private now: () => number) {}
  locked(ip: string): boolean {
    const f = this.fails.get(ip);
    return !!f && f.until > this.now();
  }
  fail(ip: string): void {
    const f = this.fails.get(ip) ?? { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= 5) {
      f.until = this.now() + 60_000;
      f.n = 0;
    }
    this.fails.set(ip, f);
  }
  ok(ip: string): void {
    this.fails.delete(ip);
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const fail = (code: string, status: number) => json({ error: code }, status);

const STATUS: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  no_such_transfer: 404,
  no_such_file: 404,
  no_such_device: 404,
  device_offline: 409,
  not_accepted: 409,
  already_sent: 409,
  not_offered: 409,
};

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** RFC 6266 attachment header that survives non-ASCII names. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function createApp(opts: Options) {
  const now = opts.now ?? Date.now;
  const room = new Room(now);
  const spool = new Spool(opts.spoolDir);
  const gate = new PinGate(now);
  const pin = (opts.pin ?? "").trim();

  const pinRequired = (ip: string) => pin !== "" && !isLoopback(ip);

  function peerOf(req: Request): string {
    return room.auth(req.headers.get("x-peer-id"), req.headers.get("x-peer-secret"));
  }

  function roomError(e: unknown): Response {
    if (e instanceof RoomError) return fail(e.code, STATUS[e.code] ?? 400);
    console.error(e);
    return fail("internal", 500);
  }

  async function upload(req: Request, id: string, idxText: string): Promise<Response> {
    if (!sameOrigin(req)) return fail("forbidden", 403);
    const idx = Number(idxText);
    let file;
    try {
      const peer = peerOf(req);
      const t = room.get(id);
      const f = t?.files[idx];
      if (f && !(await spool.hasRoomFor(f.size))) return fail("disk_full", 507);
      file = room.beginUpload(id, peer, idx);
    } catch (e) {
      return roomError(e);
    }
    let last = 0;
    try {
      await spool.write(id, idx, req.body, file.size, (n) => {
        const t = now();
        if (t - last >= 250) {
          last = t;
          room.progress(id, idx, n);
        }
      });
    } catch (e) {
      const code = e instanceof Error && (e.message === "too_long" || e.message === "incomplete") ? e.message : "upload_failed";
      room.fileFailed(id, idx, code);
      return fail(code, 400);
    }
    // A transfer cancelled while it uploaded keeps no bytes.
    if (room.get(id)?.state === "cancelled") {
      await spool.remove(id, idx + 1);
      return fail("cancelled", 409);
    }
    room.fileDone(id, idx);
    return json({ ok: true });
  }

  function download(key: string): Response {
    const hit = room.download(key);
    if (!hit) return fail("gone", 404);
    const f = Bun.file(spool.path(hit.transfer.id, hit.file.idx));
    return new Response(f, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": contentDisposition(hit.file.name),
        "content-length": String(hit.file.size),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  function onMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const send = (m: ServerMsg) => ws.send(JSON.stringify(m));
    const ref = typeof msg.ref === "string" ? msg.ref : undefined;
    try {
      if (msg.type === "hello") {
        if (pinRequired(ws.data.ip)) {
          if (gate.locked(ws.data.ip)) throw new RoomError("pin_locked");
          if (String(msg.pin ?? "") !== pin) {
            gate.fail(ws.data.ip);
            throw new RoomError("pin_wrong");
          }
          gate.ok(ws.data.ip);
        }
        const { peer, socket } = room.join(msg, send);
        ws.data.peer = peer.id;
        ws.data.socket = socket;
        return;
      }
      const me = ws.data.peer;
      if (!me) throw new RoomError("unauthorized");
      switch (msg.type) {
        case "rename":
          room.rename(me, msg.name);
          break;
        case "offer": {
          const t = room.offer(me, String(msg.to), msg.files as never);
          ws.send(JSON.stringify({ type: "offered", ref, id: t.id }));
          break;
        }
        case "respond":
          room.respond(String(msg.id), me, msg.accept === true);
          break;
        case "cancel": {
          const t = room.cancel(String(msg.id), me);
          if (t.state === "cancelled") void spool.remove(t.id, t.files.length);
          break;
        }
        case "text":
          room.text(me, String(msg.to), msg.text);
          break;
        case "ping":
          ws.send('{"type":"pong"}');
          break;
      }
    } catch (e) {
      if (e instanceof RoomError) send({ type: "error", code: e.code, ref });
      else console.error(e);
    }
  }

  const fetch = async (req: Request, server: Server<SocketData>): Promise<Response | undefined> => {
    const ip = server.requestIP(req)?.address ?? "";
    if (!isPrivateOrLoopback(ip)) return new Response("LAN only", { status: 403 });
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") return new Response("ok");
    if (path === "/api/ws") {
      if (!sameOrigin(req)) return fail("forbidden", 403);
      return server.upgrade(req, { data: { ip } }) ? undefined : fail("upgrade_failed", 400);
    }
    if (path === "/api/info" && req.method === "GET") {
      return json({ joinUrls: joinUrls(opts.port, opts.publicUrl), pinRequired: pinRequired(ip) });
    }
    let m = path.match(/^\/api\/transfers\/([a-f0-9]+)\/files\/(\d+)$/);
    if (m && (req.method === "PUT" || req.method === "POST")) return upload(req, m[1]!, m[2]!);
    m = path.match(/^\/api\/download\/([a-f0-9]+)(?:\/.*)?$/);
    if (m && req.method === "GET") return download(m[1]!);
    return undefined;
  };

  return {
    room,
    spool,
    fetch,
    websocket: {
      // Text messages are small; file bytes go over HTTP.
      maxPayloadLength: 512 * 1024,
      idleTimeout: 120,
      message: onMessage,
      close(ws: ServerWebSocket<SocketData>) {
        if (ws.data.peer && ws.data.socket) room.leave(ws.data.peer, ws.data.socket);
      },
    },
    async sweep() {
      for (const t of room.sweep()) await spool.remove(t.id, t.files.length);
    },
  };
}
