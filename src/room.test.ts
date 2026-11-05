import { describe, expect, test } from "bun:test";
import { cleanFileName, LIMITS, Room, RoomError, type ServerMsg } from "./room.ts";

function setup() {
  let t = 1_000_000;
  const room = new Room(() => t);
  const inbox: Record<string, ServerMsg[]> = { a: [], b: [] };
  const a = room.join({ id: "peer-aaaa", secret: "secret-aaaaaaaaaaaa", name: "Fox", kind: "laptop" }, (m) => inbox.a!.push(m));
  const b = room.join({ id: "peer-bbbb", secret: "secret-bbbbbbbbbbbb", name: "Owl", kind: "phone" }, (m) => inbox.b!.push(m));
  return { room, inbox, a, b, tick: (ms: number) => (t += ms) };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof RoomError ? e.code : String(e);
  }
  return null;
};

describe("Room", () => {
  test("devices see each other as they join and leave", () => {
    const { room, inbox, a } = setup();
    const peers = inbox.a!.filter((m) => m.type === "peers").at(-1);
    expect(peers).toEqual({ type: "peers", peers: [{ id: "peer-bbbb", name: "Owl", kind: "phone", online: true }] });
    room.leave("peer-bbbb", 2);
    expect(inbox.a!.at(-1)).toEqual({ type: "peers", peers: [{ id: "peer-bbbb", name: "Owl", kind: "phone", online: false }] });
    expect(a.peer.online).toBe(true);
  });

  test("a known id needs its secret, and a new socket replaces the old one", () => {
    const { room, inbox } = setup();
    expect(code(() => room.join({ id: "peer-aaaa", secret: "wrong-secret-xxxxxx" }, () => {}))).toBe("bad_secret");
    const again: ServerMsg[] = [];
    const j = room.join({ id: "peer-aaaa", secret: "secret-aaaaaaaaaaaa", name: "Fox 2" }, (m) => again.push(m));
    expect(inbox.a!.at(-1)).toEqual({ type: "replaced" });
    room.leave("peer-aaaa", 1); // the old socket closing does not take the device offline
    expect(room.peerViews().find((p) => p.id === "peer-aaaa")?.online).toBe(true);
    expect(j.peer.name).toBe("Fox 2");
  });

  test("offer → accept → upload → ready gives only the receiver a download link", () => {
    const { room, inbox } = setup();
    const t = room.offer("peer-aaaa", "peer-bbbb", [{ name: "../../etc/photo.jpg", size: 10, type: "image/jpeg" }]);
    expect(t.files[0]!.name).toBe("photo.jpg");
    expect(code(() => room.beginUpload(t.id, "peer-aaaa", 0))).toBe("not_accepted");
    expect(code(() => room.respond(t.id, "peer-aaaa", true))).toBe("forbidden");
    room.respond(t.id, "peer-bbbb", true);
    room.beginUpload(t.id, "peer-aaaa", 0);
    room.fileDone(t.id, 0);
    const toB = inbox.b!.filter((m) => m.type === "transfer").at(-1);
    const toA = inbox.a!.filter((m) => m.type === "transfer").at(-1);
    if (toB?.type !== "transfer" || toA?.type !== "transfer") throw new Error("no transfer messages");
    expect(toB.transfer.state).toBe("done");
    expect(toB.transfer.files[0]!.url).toStartWith("api/download/");
    expect(toA.transfer.files[0]!.url).toBeUndefined();
    expect(JSON.stringify(toA)).not.toContain(t.files[0]!.key);
    expect(room.download(t.files[0]!.key)?.file.name).toBe("photo.jpg");
  });

  test("offers to offline or unknown devices are refused", () => {
    const { room } = setup();
    room.leave("peer-bbbb", 2);
    expect(code(() => room.offer("peer-aaaa", "peer-bbbb", [{ name: "a", size: 1 }]))).toBe("device_offline");
    expect(code(() => room.offer("peer-aaaa", "nobody", [{ name: "a", size: 1 }]))).toBe("no_such_device");
    expect(code(() => room.offer("peer-aaaa", "peer-aaaa", [{ name: "a", size: 1 }]))).toBe("no_such_device");
  });

  test("bad file lists are refused", () => {
    const { room } = setup();
    expect(code(() => room.offer("peer-aaaa", "peer-bbbb", []))).toBe("bad_files");
    expect(code(() => room.offer("peer-aaaa", "peer-bbbb", [{ name: "a", size: -1 }]))).toBe("bad_files");
    expect(code(() => room.offer("peer-aaaa", "peer-bbbb", [{ name: "a", size: 1.5 }]))).toBe("bad_files");
  });

  test("unanswered offers expire and ended transfers are forgotten", () => {
    const { room, tick } = setup();
    const t = room.offer("peer-aaaa", "peer-bbbb", [{ name: "a", size: 1 }]);
    tick(LIMITS.offerTtlMs + 1);
    expect(room.sweep()).toEqual([]);
    expect(room.get(t.id)?.state).toBe("expired");
    tick(LIMITS.keepMs + 1);
    expect(room.sweep().map((x) => x.id)).toEqual([t.id]);
    expect(room.get(t.id)).toBeUndefined();
  });

  test("text goes to both sides", () => {
    const { room, inbox } = setup();
    room.text("peer-aaaa", "peer-bbbb", "https://example.com");
    expect(inbox.b!.at(-1)).toMatchObject({ type: "text", from: "peer-aaaa", text: "https://example.com" });
    expect(inbox.a!.at(-1)).toMatchObject({ type: "text", to: "peer-bbbb" });
    expect(code(() => room.text("peer-aaaa", "peer-bbbb", "  "))).toBe("bad_text");
  });
});

test("devices on different networks do not see or reach each other", () => {
  const room = new Room(() => 1);
  const seen: Record<string, ServerMsg[]> = { a: [], b: [], c: [] };
  room.join({ id: "peer-aaaa", secret: "secret-aaaaaaaaaaaa", name: "Home A" }, (m) => seen.a!.push(m), "home");
  room.join({ id: "peer-bbbb", secret: "secret-bbbbbbbbbbbb", name: "Home B" }, (m) => seen.b!.push(m), "home");
  room.join({ id: "peer-cccc", secret: "secret-cccccccccccc", name: "Cafe" }, (m) => seen.c!.push(m), "net:203.0.113.9");
  const last = (k: string) => seen[k]!.filter((m) => m.type === "peers" || m.type === "welcome").at(-1)!;
  const ids = (m: ServerMsg) => ((m as any).peers as { id: string }[]).map((p) => p.id);
  expect(ids(last("a"))).toEqual(["peer-bbbb"]);
  expect(ids(last("c"))).toEqual([]);
  expect(code(() => room.offer("peer-cccc", "peer-aaaa", [{ name: "x", size: 1 }]))).toBe("not_same_network");
  expect(code(() => room.text("peer-aaaa", "peer-cccc", "hi"))).toBe("not_same_network");
  // The phone comes home: it now sees the others.
  room.join({ id: "peer-cccc", secret: "secret-cccccccccccc", name: "Cafe" }, (m) => seen.c!.push(m), "home");
  expect(ids(last("c")).sort()).toEqual(["peer-aaaa", "peer-bbbb"]);
});

test("cleanFileName", () => {
  expect(cleanFileName("C:\\Users\\x\\a.txt")).toBe("a.txt");
  expect(cleanFileName("..")).toBe("file");
  expect(cleanFileName("a\u0000b.txt")).toBe("ab.txt");
  expect(cleanFileName(42)).toBe("file");
});
