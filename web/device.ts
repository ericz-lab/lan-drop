// This device: its id and secret (kept in localStorage), a friendly name, its kind.
import type { DeviceKind } from "../src/room.ts";

const COLORS = [
  ["蓝色", "Blue"], ["橙色", "Orange"], ["绿色", "Green"], ["紫色", "Purple"], ["红色", "Red"],
  ["金色", "Golden"], ["银色", "Silver"], ["青色", "Teal"], ["粉色", "Pink"], ["白色", "White"],
] as const;
const ANIMALS = [
  ["狐狸", "Fox"], ["海豚", "Dolphin"], ["松鼠", "Squirrel"], ["猫头鹰", "Owl"], ["熊猫", "Panda"],
  ["企鹅", "Penguin"], ["兔子", "Rabbit"], ["鲸鱼", "Whale"], ["老虎", "Tiger"], ["刺猬", "Hedgehog"],
] as const;

export function randomName(lang: "zh" | "en", rnd = Math.random): string {
  const c = COLORS[Math.floor(rnd() * COLORS.length)]!;
  const a = ANIMALS[Math.floor(rnd() * ANIMALS.length)]!;
  return lang === "zh" ? `${c[0]}${a[0]}` : `${c[1]} ${a[1]}`;
}

/** The device kind and a short platform label from the user agent. */
export function detect(ua: string, touchPoints = 0): { kind: DeviceKind; platform: string } {
  const s = ua.toLowerCase();
  if (/ipad/.test(s) || (/macintosh/.test(s) && touchPoints > 1)) return { kind: "tablet", platform: "iPad" };
  if (/iphone|ipod/.test(s)) return { kind: "phone", platform: "iPhone" };
  if (/android/.test(s)) return { kind: /mobile/.test(s) ? "phone" : "tablet", platform: "Android" };
  if (/harmonyos|openharmony/.test(s)) return { kind: /mobile|phone/.test(s) ? "phone" : "tablet", platform: "HarmonyOS" };
  if (/windows/.test(s)) return { kind: "laptop", platform: "Windows" };
  if (/macintosh|mac os x/.test(s)) return { kind: "laptop", platform: "Mac" };
  if (/cros/.test(s)) return { kind: "laptop", platform: "ChromeOS" };
  if (/linux/.test(s)) return { kind: "desktop", platform: "Linux" };
  return { kind: "desktop", platform: "" };
}

function hex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export interface Identity {
  id: string;
  secret: string;
  name: string;
}

const KEY = "lan-drop.device";

export function loadIdentity(lang: "zh" | "en", storage: Pick<Storage, "getItem" | "setItem"> | null): Identity {
  try {
    const raw = storage?.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (typeof v.id === "string" && typeof v.secret === "string" && typeof v.name === "string") return v;
    }
  } catch {}
  const plat = detect(navigator.userAgent, navigator.maxTouchPoints).platform;
  const ident = { id: hex(12), secret: hex(24), name: plat ? `${randomName(lang)} · ${plat}` : randomName(lang) };
  saveIdentity(ident, storage);
  return ident;
}

export function saveIdentity(ident: Identity, storage: Pick<Storage, "setItem"> | null): void {
  try {
    storage?.setItem(KEY, JSON.stringify(ident));
  } catch {}
}

export function formatBytes(n: number, lang: "zh" | "en" = "en"): string {
  void lang;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

/** "38 s" / "4 min" / "1 h 5 min". */
export function formatEta(seconds: number, lang: "zh" | "en"): string {
  const s = Math.max(1, Math.round(seconds));
  const zh = lang === "zh";
  if (s < 60) return zh ? `${s} 秒` : `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return zh ? `${m} 分钟` : `${m} min`;
  const h = Math.floor(m / 60);
  return zh ? `${h} 小时 ${m % 60} 分钟` : `${h} h ${m % 60} min`;
}
