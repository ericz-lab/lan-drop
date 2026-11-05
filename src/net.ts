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
