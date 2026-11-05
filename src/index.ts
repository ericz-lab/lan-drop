// LAN Drop's service: the page, the room socket and file relay, on every interface.
import { join } from "node:path";
import { egressKeys } from "./net.ts";
import { createApp } from "./server.ts";

const port = Number(process.env.PORT) || 9110;
const hostname = process.env.LANDROP_HOST || "0.0.0.0";
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
  const { default: page } = await import("../web/index.html");
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
    port,
    spoolDir: join(dataDir, "spool"),
    pin: process.env.LANDROP_PIN,
    publicUrl: process.env.LANDROP_PUBLIC_URL,
    directUrl: tls.url || undefined,
    pageOrigins: (process.env.LANDROP_PAGE_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  });
  await app.spool.init();

  const options = (port: number, extra: Record<string, unknown> = {}) => ({
    hostname,
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
      if (res === undefined && new URL(req.url).pathname === "/api/ws") return undefined as unknown as Response;
      return res ?? new Response("Not found", { status: 404 });
    },
    websocket: app.websocket,
    ...extra,
  });
  const server = Bun.serve(options(port));

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
    direct?.stop(true);
    process.exit(0);
  });
  console.log(`lan-drop listening on http://${hostname}:${port}`);
}
