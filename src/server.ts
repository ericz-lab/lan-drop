// The HTTP and WebSocket handlers: the room over a socket, uploads into the spool, downloads out.
import type { Server, ServerWebSocket } from "bun";
import { HOME, isLoopback, isPrivateOrLoopback, joinUrls, networkOf } from "./net.ts";
import { Room, RoomError, type ServerMsg } from "./room.ts";
import { Spool } from "./spool.ts";
import { uniqueNames, zipSize, zipStream } from "./zip.ts";
import { cleanFileName } from "./room.ts";

export interface Options {
  port: number;
  spoolDir: string;
  /** A room PIN for devices that are not this machine; empty for none. */
  pin?: string;
  /** Overrides the join URLs shown (comma-separated). */
  publicUrl?: string;
  /** The host's own public addresses (src/net.ts egressKeys): devices behind them are home. */
  homeKeys?: () => ReadonlySet<string>;
  /**
   * The https address of this server on the LAN (a name that resolves to the LAN address, with a
   * real certificate), e.g. https://lan.example.org:9111/. A page opened through the router probes
   * it and, when it answers, moves file bytes there instead of through the tunnel.
   */
  directUrl?: string;
  /** Page origins (the router's https names) that may send and fetch file bytes cross-origin. */
  pageOrigins?: string[];
  now?: () => number;
}

interface SocketData {
  ip: string;
  net: string;
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
  not_uploading: 409,
  not_same_network: 403,
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

/** File-byte routes a page on another origin may use once it found the direct address. */
const BYTE_ROUTE = /^\/api\/(ping|zip|download\/|transfers\/)/;

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
  // Tells a probing page it reached this very server, not another box at the same address.
  const instance = crypto.randomUUID();
  const pageOrigins = new Set((opts.pageOrigins ?? []).map((o) => o.replace(/\/$/, "")));
  const allowedOrigin = (req: Request) => {
    const o = req.headers.get("origin");
    return o && pageOrigins.has(o) ? o : null;
  };
  const allowed = (req: Request) => sameOrigin(req) || allowedOrigin(req) !== null;

  const homeKeys = opts.homeKeys ?? (() => new Set<string>());
  // Through the router (behind the space's login) the device is signed in; the PIN guards the LAN port.
  const pinRequired = (ip: string) => pin !== "" && !isLoopback(ip);
  const netOf = (ip: string, req: Request) => networkOf(ip, req.headers, homeKeys());

  function peerOf(req: Request): string {
    return room.auth(req.headers.get("x-peer-id"), req.headers.get("x-peer-secret"));
  }

  function roomError(e: unknown): Response {
    if (e instanceof RoomError) return fail(e.code, STATUS[e.code] ?? 400);
    console.error(e);
    return fail("internal", 500);
  }

  /**
   * One piece of a file. `offset=0` (or none) starts the file; later pieces continue it where the
   * last one ended. Pieces keep each request under the 100 MB a Cloudflare tunnel allows.
   */
  async function upload(req: Request, id: string, idxText: string, offsetText: string | null): Promise<Response> {
    if (!allowed(req)) return fail("forbidden", 403);
    const idx = Number(idxText);
    const offset = Number(offsetText ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return fail("bad_offset", 400);
    let file;
    try {
      const peer = peerOf(req);
      const t = room.get(id);
      if (!t) throw new RoomError("no_such_transfer");
      if (t.from !== peer) throw new RoomError("forbidden");
      const f = t.files[idx];
      if (!f) throw new RoomError("no_such_file");
      if (offset === 0) {
        if (!(await spool.hasRoomFor(f.size))) return fail("disk_full", 507);
        file = room.beginUpload(id, peer, idx);
      } else {
        if (t.state !== "accepted" || f.state !== "uploading") throw new RoomError("not_uploading");
        file = f;
      }
    } catch (e) {
      return roomError(e);
    }
    let last = 0;
    let total: number;
    try {
      total = await spool.write(
        id,
        idx,
        req.body,
        file.size,
        (n) => {
          const t = now();
          if (t - last >= 250) {
            last = t;
            room.progress(id, idx, n);
          }
        },
        offset,
      );
    } catch (e) {
      const code = e instanceof Error && ["too_long", "bad_offset"].includes(e.message) ? e.message : "upload_failed";
      room.fileFailed(id, idx, code);
      return fail(code, 400);
    }
    // A transfer cancelled while it uploaded keeps no bytes.
    if (room.get(id)?.state === "cancelled") {
      await spool.remove(id, idx + 1);
      return fail("cancelled", 409);
    }
    if (total === file.size) room.fileDone(id, idx);
    else room.progress(id, idx, total);
    return json({ ok: true, received: total });
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

  /** Several received files as one ZIP: one download instead of many a browser may block. */
  function zip(keysText: string, nameText: string | null): Response {
    const keys = keysText.split(",").filter((k) => /^[a-f0-9]+$/.test(k)).slice(0, 1000);
    const hits = keys.map((k) => room.download(k)).filter((h) => h !== null);
    if (hits.length === 0 || hits.length !== keys.length) return fail("gone", 404);
    const names = uniqueNames(hits.map((h) => h.file.name));
    const entries = hits.map((h, i) => ({ name: names[i]!, size: h.file.size, path: spool.path(h.transfer.id, h.file.idx) }));
    const size = zipSize(entries);
    if (size === null) return fail("too_big", 413);
    let name = cleanFileName(nameText ?? "lan-drop.zip");
    if (!/\.zip$/i.test(name)) name += ".zip";
    return new Response(zipStream(entries), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": contentDisposition(name),
        "content-length": String(size),
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
        const { peer, socket } = room.join(msg, send, ws.data.net);
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

  const route = async (req: Request, server: Server<SocketData>): Promise<Response | undefined> => {
    const ip = server.requestIP(req)?.address ?? "";
    if (!isPrivateOrLoopback(ip)) return new Response("LAN only", { status: 403 });
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") return new Response("ok");
    if (path === "/api/ping" && req.method === "GET") return json({ ok: true, instance });
    if (path === "/api/ws") {
      if (!sameOrigin(req)) return fail("forbidden", 403);
      return server.upgrade(req, { data: { ip, net: netOf(ip, req) } }) ? undefined : fail("upgrade_failed", 400);
    }
    if (path === "/api/info" && req.method === "GET") {
      // Through the router the page's own address is the one to share: it works from any network.
      const host = isLoopback(ip) ? req.headers.get("x-forwarded-host") : null;
      // The router itself speaks plain http behind the TLS tunnel; the public name is https.
      const viaDomain = host ? [`https://${host}/`] : [];
      return json({
        joinUrls: [...viaDomain, ...joinUrls(opts.port, opts.publicUrl)],
        lanUrls: joinUrls(opts.port, opts.publicUrl),
        pinRequired: pinRequired(ip),
        home: netOf(ip, req) === HOME,
        viaRouter: !!host,
        // Only a page through the router needs it: on the LAN the page is direct already.
        direct: host && opts.directUrl ? opts.directUrl : null,
        instance,
      });
    }
    let m = path.match(/^\/api\/transfers\/([a-f0-9]+)\/files\/(\d+)$/);
    if (m && (req.method === "PUT" || req.method === "POST")) return upload(req, m[1]!, m[2]!, url.searchParams.get("offset"));
    if (path === "/api/zip" && req.method === "GET") return zip(url.searchParams.get("keys") ?? "", url.searchParams.get("name"));
    m = path.match(/^\/api\/download\/([a-f0-9]+)(?:\/.*)?$/);
    if (m && req.method === "GET") return download(m[1]!);
    return undefined;
  };

  /** The routes, plus CORS for a page on a listed origin that moved its file bytes here. */
  const fetch = async (req: Request, server: Server<SocketData>): Promise<Response | undefined> => {
    const origin = allowedOrigin(req);
    const path = new URL(req.url).pathname;
    if (!origin || !BYTE_ROUTE.test(path)) return route(req, server);
    const cors: Record<string, string> = {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-peer-id, x-peer-secret",
      "access-control-max-age": "600",
      // Chrome asks before a public page reaches a private address.
      "access-control-allow-private-network": "true",
      vary: "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const res = await route(req, server);
    if (!res) return res;
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
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
