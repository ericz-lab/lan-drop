import { expect, test } from "bun:test";
import { detect, formatBytes, formatEta, randomName } from "./device.ts";

test("detect", () => {
  expect(detect("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toEqual({ kind: "phone", platform: "iPhone" });
  expect(detect("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toEqual({ kind: "tablet", platform: "iPad" });
  expect(detect("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toEqual({ kind: "laptop", platform: "Mac" });
  expect(detect("Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari")).toEqual({ kind: "phone", platform: "Android" });
  expect(detect("Mozilla/5.0 (Linux; Android 15; SM-X910) Safari")).toEqual({ kind: "tablet", platform: "Android" });
  expect(detect("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toEqual({ kind: "laptop", platform: "Windows" });
  expect(detect("Mozilla/5.0 (X11; Linux x86_64)")).toEqual({ kind: "desktop", platform: "Linux" });
});

test("randomName", () => {
  expect(randomName("zh", () => 0)).toBe("蓝色狐狸");
  expect(randomName("en", () => 0.99)).toBe("White Hedgehog");
});

test("formatBytes and formatEta", () => {
  expect(formatBytes(220 * 1024)).toBe("220 KB");
  expect(formatBytes(1.18 * 1024 ** 3)).toBe("1.18 GB");
  expect(formatBytes(12)).toBe("12 B");
  expect(formatEta(38, "zh")).toBe("38 秒");
  expect(formatEta(3900, "en")).toBe("1 h 5 min");
});
