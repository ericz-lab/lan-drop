// End to end over a real socket: two devices join, one sends a file, the other downloads it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentDisposition, createApp } from "./server.ts";

let dir = "";
let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "lan-drop-"));
  const app = createApp({ port: 0, spoolDir: dir, pin: "4321" });
  await app.spool.init();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req, srv) => {
      const r = await app.fetch(req, srv as never);
      return r ?? (undefined as unknown as Response);
    },
    websocket: app.websocket as never,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

function device(id: string, secret: string, name: string) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/api/ws`);
  const msgs: any[] = [];
  const waiters: { pred: (m: any) => boolean; res: (m: any) => void }[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.res(m);
    }
  };
  const next = (pred: (m: any) => boolean) =>
    new Promise<any>((res) => {
      const hit = msgs.find(pred);
      if (hit) return res(hit);
      waiters.push({ pred, res });
    });
  const open = new Promise<void>((r) => (ws.onopen = () => r())).then(() =>
    ws.send(JSON.stringify({ type: "hello", id, secret, name, kind: "laptop" })),
  );
  return { ws, msgs, next, open, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

test("send a file from one device to another", async () => {
  const a = device("dev-aaaaaaaa", "secret-aaaaaaaaaaaaaaaa", "Fox");
  const b = device("dev-bbbbbbbb", "secret-bbbbbbbbbbbbbbbb", "Owl");
  await Promise.all([a.open, b.open]);
  await a.next((m) => m.type === "peers" && m.peers.some((p: any) => p.id === "dev-bbbbbbbb"));

  const body = new TextEncoder().encode("hello, 局域网");
  a.send({ type: "offer", ref: "r1", to: "dev-bbbbbbbb", files: [{ name: "你好.txt", size: body.byteLength, type: "text/plain" }] });
  const { id } = await a.next((m) => m.type === "offered" && m.ref === "r1");
  await b.next((m) => m.type === "transfer" && m.transfer.id === id && m.transfer.state === "offered");

  const headers = { "x-peer-id": "dev-aaaaaaaa", "x-peer-secret": "secret-aaaaaaaaaaaaaaaa" };
  // Not accepted yet.
  expect((await fetch(`${base}/api/transfers/${id}/files/0`, { method: "PUT", headers, body })).status).toBe(409);
  b.send({ type: "respond", id, accept: true });
  await a.next((m) => m.type === "transfer" && m.transfer.state === "accepted");

  // Wrong credentials, then a body of the wrong length, then the real upload.
  expect((await fetch(`${base}/api/transfers/${id}/files/0`, { method: "PUT", headers: { ...headers, "x-peer-secret": "nope" }, body })).status).toBe(401);
  expect((await fetch(`${base}/api/transfers/${id}/files/0`, { method: "PUT", headers, body: body.slice(0, 3) })).status).toBe(400);
  const up = await fetch(`${base}/api/transfers/${id}/files/0`, { method: "PUT", headers, body });
  expect(up.status).toBe(200);

  const done = await b.next((m) => m.type === "transfer" && m.transfer.state === "done");
  const url = done.transfer.files[0].url as string;
  const res = await fetch(`${base}/${url}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''%E4%BD%A0%E5%A5%BD.txt");
  expect(await res.text()).toBe("hello, 局域网");

  a.ws.close();
  b.ws.close();
});

test("a socket from another site is refused", async () => {
  const res = await fetch(`${base}/api/ws`, { headers: { origin: "http://evil.example", upgrade: "websocket" } });
  expect(res.status).toBe(403);
});

test("loopback needs no PIN; info says so", async () => {
  const info = await (await fetch(`${base}/api/info`)).json();
  expect(info.pinRequired).toBe(false);
});

test("contentDisposition keeps an ASCII fallback", () => {
  expect(contentDisposition('a"b.txt')).toBe(`attachment; filename="a_b.txt"; filename*=UTF-8''a%22b.txt`);
});
