import { expect, test } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { egressKeys, HOME, isPrivateOrLoopback, joinUrls, lanAddresses, networkOf } from "./net.ts";

test("only loopback and private addresses are let in", () => {
  for (const ip of ["127.0.0.1", "::1", "::ffff:192.168.3.20", "10.1.2.3", "172.16.0.1", "172.31.255.1", "169.254.1.1", "fd00::1", "fe80::1%wlan0"]) {
    expect(isPrivateOrLoopback(ip)).toBe(true);
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "192.169.0.1", "::ffff:1.1.1.1", "2001:db8::1", ""]) {
    expect(isPrivateOrLoopback(ip)).toBe(false);
  }
});

const iface = (address: string, internal = false): NetworkInterfaceInfo =>
  ({ address, internal, family: "IPv4", netmask: "255.255.255.0", mac: "", cidr: null }) as NetworkInterfaceInfo;

test("join URLs skip containers and loopback, Wi-Fi first", () => {
  const ifaces = {
    lo: [iface("127.0.0.1", true)],
    docker0: [iface("172.17.0.1")],
    "br-05e0": [iface("172.22.0.1")],
    zeth0: [iface("10.0.0.5")],
    wlp4s0: [iface("192.168.3.48")],
  };
  expect(lanAddresses(ifaces).map((a) => a.address)).toEqual(["192.168.3.48", "10.0.0.5"]);
  expect(joinUrls(9110, undefined, ifaces)[0]).toBe("http://192.168.3.48:9110/");
  expect(joinUrls(9110, "http://drop.home/, http://x/", ifaces)).toEqual(["http://drop.home/", "http://x/"]);
});

test("network of a request", () => {
  const home = new Set(["43.164.191.143", "2001:db8:1:2::/64"]);
  const h = (ip?: string) => new Headers(ip ? { "cf-connecting-ip": ip } : {});
  expect(networkOf("192.168.3.20", h("8.8.8.8"), home)).toBe(HOME); // a LAN device cannot claim another network
  expect(networkOf("127.0.0.1", h(), home)).toBe(HOME);
  expect(networkOf("127.0.0.1", h("43.164.191.143"), home)).toBe(HOME);
  expect(networkOf("127.0.0.1", h("2001:db8:1:2:aaaa::5"), home)).toBe(HOME);
  expect(networkOf("127.0.0.1", h("203.0.113.9"), home)).toBe("net:203.0.113.9");
  expect(networkOf("::1", h("2001:db8:9::1"), home)).toBe("net:2001:db8:9:0::/64");
});

test("egressKeys reads Cloudflare's trace and the extra list", async () => {
  const fake = (async (url: string) => new Response(String(url).includes("[") ? "x=1\nip=2001:db8:1:2:3:4:5:6\n" : "ip=198.51.100.7\n")) as unknown as typeof fetch;
  expect([...(await egressKeys("203.0.113.1", fake))].sort()).toEqual(["198.51.100.7", "2001:db8:1:2::/64", "203.0.113.1"]);
});
