import { describe, expect, it } from "vitest";
import {
  addressKey,
  blockedReason,
  isAllowedPort,
  isBlockedAddress,
  parseAddressPort,
  parseIp,
  parseIpv4,
  parseIpv6,
  parseTarget,
} from "./address";
import { HttpError } from "./types";

function kindOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof HttpError ? error.kind : "other";
  }
}

describe("IP parsing", () => {
  it("parses dotted IPv4 and refuses other forms", () => {
    expect(parseIpv4("192.168.1.20")).toEqual([192, 168, 1, 20]);
    expect(parseIpv4("256.1.1.1")).toBeNull();
    expect(parseIpv4("01.2.3.4")).toBeNull();
    expect(parseIpv4("1.2.3")).toBeNull();
    expect(parseIpv4("2130706433")).toBeNull();
  });

  it("parses IPv6 forms", () => {
    expect(parseIpv6("::1")).toEqual([...new Array<number>(15).fill(0), 1]);
    expect(parseIpv6("[::]")).toEqual(new Array<number>(16).fill(0));
    expect(parseIpv6("::ffff:127.0.0.1")?.slice(10)).toEqual([0xff, 0xff, 127, 0, 0, 1]);
    expect(parseIpv6("fe80::1%en0")?.slice(0, 2)).toEqual([0xfe, 0x80]);
    expect(parseIpv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIpv6("1::2::3")).toBeNull();
    expect(parseIpv6("example.com")).toBeNull();
  });

  it("parseIp gives the family", () => {
    expect(parseIp("8.8.8.8")?.family).toBe(4);
    expect(parseIp("2606:4700:4700::1111")?.family).toBe(6);
    expect(parseIp("example.com")).toBeNull();
  });
});

describe("blocked IPv4 ranges", () => {
  // [first address, last address, an address just outside the range]
  const cases: Array<[string, string, string, string | null]> = [
    ["0.0.0.0/8", "0.0.0.0", "0.255.255.255", "1.0.0.0"],
    ["10/8", "10.0.0.0", "10.255.255.255", "11.0.0.0"],
    ["100.64/10", "100.64.0.0", "100.127.255.255", "100.128.0.0"],
    ["127/8", "127.0.0.0", "127.255.255.255", "128.0.0.0"],
    ["169.254/16", "169.254.0.0", "169.254.255.255", "169.255.0.0"],
    ["172.16/12", "172.16.0.0", "172.31.255.255", "172.32.0.0"],
    ["192.0.0/24", "192.0.0.0", "192.0.0.255", "192.0.1.0"],
    ["192.0.2/24", "192.0.2.0", "192.0.2.255", "192.0.3.0"],
    ["192.168/16", "192.168.0.0", "192.168.255.255", "192.169.0.0"],
    ["198.18/15", "198.18.0.0", "198.19.255.255", "198.20.0.0"],
    ["198.51.100/24", "198.51.100.0", "198.51.100.255", "198.51.101.0"],
    ["203.0.113/24", "203.0.113.0", "203.0.113.255", "203.0.114.0"],
    ["224/4", "224.0.0.0", "239.255.255.255", null],
    ["240/4", "240.0.0.0", "255.255.255.255", null],
  ];

  it.each(cases)("blocks %s", (_name, first, last, outside) => {
    expect(isBlockedAddress(first)).toBe(true);
    expect(isBlockedAddress(last)).toBe(true);
    if (outside) expect(isBlockedAddress(outside)).toBe(false);
  });

  it("allows public IPv4 addresses", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "93.184.215.14", "100.63.255.255", "172.15.255.255", "223.255.255.255"]) {
      expect(blockedReason(address)).toBeNull();
    }
  });

  it("names the metadata range", () => {
    expect(blockedReason("169.254.169.254")).toMatch(/link-local/);
  });
});

describe("blocked IPv6 ranges", () => {
  it.each([
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fc00::1", "unique local"],
    ["fdff:ffff::1", "unique local"],
    ["fe80::1", "link-local"],
    ["febf:ffff::1", "link-local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["2001:db8:ffff::1", "documentation"],
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it("blocks IPv4-mapped and NAT64 forms of a blocked IPv4 address", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:10.1.2.3")).toBe(true);
    expect(isBlockedAddress("64:ff9b::127.0.0.1")).toBe(true);
    expect(isBlockedAddress("64:ff9b::a9fe:a9fe")).toBe(true);
    expect(isBlockedAddress("64:ff9b::192.168.0.1")).toBe(true);
  });

  it("allows mapped and NAT64 forms of a public IPv4 address, and public IPv6", () => {
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedAddress("64:ff9b::8.8.8.8")).toBe(false);
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedAddress("2a00:1450:4001:80b::200e")).toBe(false);
    expect(isBlockedAddress("fbff::1")).toBe(false);
  });

  it("fails closed for text that is not an address", () => {
    expect(isBlockedAddress("example.com")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("ports and keys", () => {
  it("allows 80, 443, and 1024 or higher", () => {
    expect(isAllowedPort(80)).toBe(true);
    expect(isAllowedPort(443)).toBe(true);
    expect(isAllowedPort(1024)).toBe(true);
    expect(isAllowedPort(65535)).toBe(true);
    expect(isAllowedPort(22)).toBe(false);
    expect(isAllowedPort(1023)).toBe(false);
    expect(isAllowedPort(0)).toBe(false);
    expect(isAllowedPort(65536)).toBe(false);
  });

  it("gives one key for one address and port", () => {
    expect(parseAddressPort("127.0.0.1:4420")).toBe(addressKey("127.0.0.1", 4420));
    expect(parseAddressPort("[::1]:4421")).toBe(addressKey("0:0:0:0:0:0:0:1", 4421));
    expect(parseAddressPort("localhost:4420")).toBeNull();
    expect(parseAddressPort("127.0.0.1")).toBeNull();
  });
});

describe("parseTarget", () => {
  it("accepts http and https and finds the port and the Host header", () => {
    const plain = parseTarget("http://Example.COM/a?b=1#frag");
    expect(plain.port).toBe(80);
    expect(plain.hostHeader).toBe("example.com");
    expect(plain.url.href).toBe("http://example.com/a?b=1");
    const secure = parseTarget("https://example.com:8443/");
    expect(secure.https).toBe(true);
    expect(secure.port).toBe(8443);
    expect(secure.hostHeader).toBe("example.com:8443");
  });

  it("refuses other schemes, credentials, and low ports", () => {
    expect(kindOf(() => parseTarget("ftp://example.com/"))).toBe("bad_url");
    expect(kindOf(() => parseTarget("file:///etc/passwd"))).toBe("bad_url");
    expect(kindOf(() => parseTarget("javascript:alert(1)"))).toBe("bad_url");
    expect(kindOf(() => parseTarget("http://user:pass@example.com/"))).toBe("bad_url");
    expect(kindOf(() => parseTarget("http://user@example.com/"))).toBe("bad_url");
    expect(kindOf(() => parseTarget("http://example.com:22/"))).toBe("bad_url");
    expect(kindOf(() => parseTarget("https://example.com:1023/"))).toBe("bad_url");
    expect(kindOf(() => parseTarget("not a url"))).toBe("bad_url");
    expect(kindOf(() => parseTarget("http://1.2.3.4.5/"))).toBe("bad_url");
  });

  it("normalizes the numeric IPv4 forms to the dotted form", () => {
    for (const url of ["http://2130706433/", "http://0x7f000001/", "http://017700000001/", "http://127.1/", "http://0x7f.0.0.1/"]) {
      const target = parseTarget(url);
      expect(target.hostname).toBe("127.0.0.1");
      expect(target.literal?.family).toBe(4);
      expect(isBlockedAddress(target.hostname)).toBe(true);
    }
  });

  it("reads IPv6 literals", () => {
    const target = parseTarget("http://[::ffff:127.0.0.1]:8080/");
    expect(target.literal?.family).toBe(6);
    expect(isBlockedAddress(target.hostname)).toBe(true);
    expect(target.hostHeader).toBe("[::ffff:7f00:1]:8080");
  });
});
