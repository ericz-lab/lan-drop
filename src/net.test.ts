import { expect, test } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { isPrivateOrLoopback, joinUrls, lanAddresses } from "./net.ts";

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
