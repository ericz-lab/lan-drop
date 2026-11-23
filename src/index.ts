// LAN Drop's service: the page, the room socket and file relay, on every interface.
import { join } from "node:path";
import { egressKeys } from "./net.ts";
import { createApp } from "./server.ts";
import page from "../web/index.html";

const port = Number(process.env.PORT) || 9110;
const hostname = process.env.LANDROP_HOST || "0.0.0.0";
// The port phones on the Wi-Fi use. The git deployment runs on it (PORT 9110). An installed package
// gets a new loopback PORT from ai-space at every start, for the space's gateway only, so it listens
// on the LAN apart, on this fixed port, and the address in the QR code stays the same.
const lanPort = Number(process.env.LANDROP_LAN_PORT) || 9110;
// Direct https on the LAN (see README): a port, a certificate for a name that resolves to the LAN
// address, and that name's URL.
const tls = {
  port: Number(process.env.LANDROP_TLS_PORT) || 0,
  cert: process.env.LANDROP_TLS_CERT ?? "",
  key: process.env.LANDROP_TLS_KEY ?? "",
  url: process.env.LANDROP_DIRECT_URL ?? "",
};
const dataDir = process.env.SPACE_APP_DATA_DIR || join(import.meta.dir, "..", "data");

if (import.meta.main) {
  // The bundled release (dist/index.js) finds its page's files from the working directory: run in its own.
  if (!Bun.main.endsWith(".ts")) process.chdir(import.meta.dir);
  // Which public addresses are this host's own network, refreshed every ten minutes.
  let homeKeys: ReadonlySet<string> = new Set();
  const refreshHome = async () => {
    homeKeys = await egressKeys(process.env.LANDROP_HOME_IPS ?? "");
  };
  await refreshHome();
  setInterval(() => void refreshHome(), 10 * 60_000);
  console.log(`home public addresses: ${[...homeKeys].join(", ") || "none found"}`);

  const app = createApp({
    homeKeys: () => homeKeys,
    port: lanPort,
    spoolDir: join(dataDir, "spool"),
    pin: process.env.LANDROP_PIN,
    publicUrl: process.env.LANDROP_PUBLIC_URL,
    directUrl: tls.url || undefined,
    pageOrigins: (process.env.LANDROP_PAGE_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  });
  await app.spool.init();

  const options = (port: number, extra: Record<string, unknown> = {}, host = hostname) => ({
    hostname: host,
    port,
    idleTimeout: 255,
    // Files of any size come in as streams.
    maxRequestBodySize: 1024 ** 4,
    development: false,
    routes: {
      "/": page,
      "/icon.svg": new Response(Bun.file(join(import.meta.dir, "..", "icon.svg")), {
        headers: { "content-type": "image/svg+xml" },
      }),
    },
    fetch: async (req: Request, srv: Parameters<typeof app.fetch>[1]) => {
      const res = await app.fetch(req, srv);
      const path = new URL(req.url).pathname;
      if (res === undefined && path === "/api/ws") return undefined as unknown as Response;
      // A bundled release (`bun run build`) serves its hashed pictures from beside the bundle; from source they are routes of the page.
      if ((!res || res.status === 404) && req.method === "GET" && /^\/[A-Za-z0-9_-]+-[a-z0-9]{8}\.(png|svg|webp|ico|jpg)$/.test(path)) {
        const file = Bun.file(Bun.fileURLToPath(new URL(`.${path}`, import.meta.url)));
        if (await file.exists()) return new Response(file, { headers: { "cache-control": "max-age=31536000, immutable" } });
      }
      return res ?? new Response("Not found", { status: 404 });
    },
    websocket: app.websocket,
    ...extra,
  });
  // One listener when PORT is the LAN port (the git deployment); else the gateway's on loopback and the LAN's apart.
  const server = Bun.serve(port === lanPort ? options(port) : options(port, {}, "127.0.0.1"));
  const lan = port === lanPort ? null : Bun.serve(options(lanPort));

  // The same app over https on its own port, when a certificate for a LAN name is configured.
  let direct: ReturnType<typeof Bun.serve> | null = null;
  let loaded = "";
  const serveTls = async () => {
    let cert: string, key: string;
    try {
      [cert, key] = await Promise.all([Bun.file(tls.cert).text(), Bun.file(tls.key).text()]);
    } catch (e) {
      console.error(`direct https: cannot read the certificate: ${e}`);
      return;
    }
    if (cert + key === loaded) return;
    // A renewed certificate: stop listening, let open requests finish, listen again with it.
    direct?.stop(false);
    direct = Bun.serve(options(tls.port, { tls: { cert, key } }) as never);
    loaded = cert + key;
    console.log(`direct https on port ${tls.port} as ${tls.url}`);
  };
  if (tls.port && tls.cert && tls.key && tls.url) {
    await serveTls();
    setInterval(() => void serveTls(), 6 * 3600_000);
  }

  setInterval(() => void app.sweep(), 30_000);
  process.on("SIGTERM", () => {
    server.stop(true);
    lan?.stop(true);
    direct?.stop(true);
    process.exit(0);
  });
  console.log(`lan-drop listening on http://${port === lanPort ? hostname : "127.0.0.1"}:${port}`);
  if (lan) console.log(`lan-drop on the LAN at http://${hostname}:${lanPort}`);
}
