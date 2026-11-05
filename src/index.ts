// LAN Drop's service: the page, the room socket and file relay, on every interface.
import { join } from "node:path";
import { createApp } from "./server.ts";

const port = Number(process.env.PORT) || 9110;
const hostname = process.env.LANDROP_HOST || "0.0.0.0";
const dataDir = process.env.SPACE_APP_DATA_DIR || join(import.meta.dir, "..", "data");

if (import.meta.main) {
  const { default: page } = await import("../web/index.html");
  const app = createApp({
    port,
    spoolDir: join(dataDir, "spool"),
    pin: process.env.LANDROP_PIN,
    publicUrl: process.env.LANDROP_PUBLIC_URL,
  });
  await app.spool.init();

  const server = Bun.serve({
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
    fetch: async (req, srv) => {
      const res = await app.fetch(req, srv);
      if (res === undefined && new URL(req.url).pathname === "/api/ws") return undefined as unknown as Response;
      return res ?? new Response("Not found", { status: 404 });
    },
    websocket: app.websocket,
  });

  setInterval(() => void app.sweep(), 30_000);
  process.on("SIGTERM", () => {
    server.stop(true);
    process.exit(0);
  });
  console.log(`lan-drop listening on http://${hostname}:${port}`);
}
