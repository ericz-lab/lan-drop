// Who may connect (loopback and private addresses only) and the addresses other devices use.
import { networkInterfaces } from "node:os";

/** Strips the IPv4-mapped IPv6 prefix and an interface zone. */
export function normalizeIp(ip: string): string {
  let a = ip.trim().toLowerCase();
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  if (a.startsWith("::ffff:") && a.includes(".")) a = a.slice(7);
  return a;
}

function ipv4(a: string): number[] | null {
  const parts = a.split(".");
  if (parts.length !== 4) return null;
  const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : null;
}

export function isLoopback(ip: string): boolean {
  const a = normalizeIp(ip);
  if (a === "::1") return true;
  const v4 = ipv4(a);
  return v4 !== null && v4[0] === 127;
}

/** Loopback, RFC 1918, link-local, CGNAT-free private IPv6 (fc00::/7) and link-local IPv6. */
export function isPrivateOrLoopback(ip: string): boolean {
  const a = normalizeIp(ip);
  if (isLoopback(a)) return true;
  const v4 = ipv4(a);
  if (v4) {
    const [x, y] = v4 as [number, number, number, number];
    return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254);
  }
  if (!a.includes(":")) return false;
  return /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
}

/** Interfaces that are not the machine's LAN: containers, bridges, VPN tunnels. */
const VIRTUAL = /^(docker|br-|veth|lxc|virbr|vmnet|vboxnet|tun|tap|utun|tailscale|zt|wg|cni|flannel|podman)/;

export interface LanAddress {
  iface: string;
  address: string;
}

/** Private IPv4 addresses of real interfaces, Wi-Fi and Ethernet first. */
export function lanAddresses(ifaces = networkInterfaces()): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list || VIRTUAL.test(name)) continue;
    for (const i of list) {
      if (i.internal || i.family !== "IPv4") continue;
      if (!isPrivateOrLoopback(i.address) || isLoopback(i.address)) continue;
      out.push({ iface: name, address: i.address });
    }
  }
  const rank = (n: string) => (/^(wl|wlan|wifi|en|eth)/.test(n) ? 0 : 1);
  return out.sort((a, b) => rank(a.iface) - rank(b.iface) || a.iface.localeCompare(b.iface));
}

/** The URLs to show for joining: LANDROP_PUBLIC_URL when set, else http://<lan ip>:<port>/. */
export function joinUrls(port: number, override?: string, ifaces = networkInterfaces()): string[] {
  if (override) return override.split(",").map((s) => s.trim()).filter(Boolean);
  return lanAddresses(ifaces).map((a) => `http://${a.address}:${port}/`);
}

/** The network a device is on: "home" for the host's own LAN, else one key per public address. */
export const HOME = "home";

/** An IPv6 address's /64 prefix (one home network), an IPv4 address as it is. */
export function publicKey(ip: string): string {
  const a = normalizeIp(ip);
  if (!a.includes(":")) return a;
  // Expand "::" so the first four groups are the prefix.
  const [head = "", tail = ""] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = a.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = a.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/**
 * Which network a request is from. A direct connection from a private address is the host's LAN.
 * Through the space's router (the TCP peer is loopback), Cloudflare's `Cf-Connecting-IP` names the
 * device's public address: the host's own egress address counts as home, any other address is its
 * own network. Only the loopback peer's header is trusted; a LAN device cannot claim another network.
 */
export function networkOf(peerIp: string, headers: Headers, homeKeys: ReadonlySet<string>): string {
  if (!isLoopback(peerIp)) return HOME;
  const forwarded = headers.get("cf-connecting-ip")?.trim();
  if (!forwarded) return HOME;
  if (isPrivateOrLoopback(forwarded)) return HOME;
  const key = publicKey(forwarded);
  return homeKeys.has(key) ? HOME : `net:${key}`;
}

/** The host's own public addresses, as Cloudflare sees them, plus LANDROP_HOME_IPS. */
export async function egressKeys(extra = "", fetcher: typeof fetch = fetch): Promise<Set<string>> {
  const keys = new Set(extra.split(",").map((s) => s.trim()).filter(Boolean).map(publicKey));
  for (const url of ["https://1.1.1.1/cdn-cgi/trace", "https://[2606:4700:4700::1111]/cdn-cgi/trace"]) {
    try {
      const res = await fetcher(url, { signal: AbortSignal.timeout(5000) });
      const ip = (await res.text()).match(/^ip=(.+)$/m)?.[1];
      if (ip) keys.add(publicKey(ip));
    } catch {}
  }
  return keys;
}
