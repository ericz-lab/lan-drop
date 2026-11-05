import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uniqueNames, zipSize, zipStream } from "./zip.ts";

const dir = await mkdtemp(join(tmpdir(), "lan-drop-zip-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

test("uniqueNames", () => {
  expect(uniqueNames(["a.jpg", "b.jpg", "A.jpg", "a.jpg", "notes"])).toEqual(["a.jpg", "b.jpg", "A (2).jpg", "a (3).jpg", "notes"]);
});

test("zipSize refuses what a plain ZIP cannot hold", () => {
  expect(zipSize([{ name: "a", size: 5 }])).toBe(30 + 1 + 10 + 5 + 16 + 46 + 1 + 10 + 22);
  expect(zipSize([{ name: "a", size: 2 ** 32 }])).toBeNull();
});

test("the archive unzips to the same files, with Chinese names", async () => {
  const files = [
    { name: "照片 1.jpg", body: new Uint8Array(300_000).map((_, i) => (i * 7) % 256) },
    { name: "notes.txt", body: new TextEncoder().encode("hello") },
    { name: "empty.bin", body: new Uint8Array(0) },
  ];
  const entries = [];
  for (const [i, f] of files.entries()) {
    const path = join(dir, `src-${i}`);
    await Bun.write(path, f.body);
    entries.push({ name: f.name, path, size: f.body.byteLength });
  }
  const bytes = new Uint8Array(await new Response(zipStream(entries)).arrayBuffer());
  expect(bytes.byteLength).toBe(zipSize(entries)!);
  const zipPath = join(dir, "out.zip");
  await Bun.write(zipPath, bytes);
  const test = Bun.spawnSync(["unzip", "-t", zipPath]);
  expect(test.stdout.toString()).toContain("No errors detected");
  const out = join(dir, "out");
  Bun.spawnSync(["unzip", "-q", zipPath, "-d", out]);
  for (const f of files) expect(new Uint8Array(await Bun.file(join(out, f.name)).arrayBuffer())).toEqual(f.body);
  // Python reads the UTF-8 flag too.
  const py = Bun.spawnSync(["python3", "-c", `import zipfile,sys; print("|".join(zipfile.ZipFile(sys.argv[1]).namelist()))`, zipPath]);
  if (py.exitCode === 0) expect(py.stdout.toString().trim()).toBe(files.map((f) => f.name).join("|"));
});
