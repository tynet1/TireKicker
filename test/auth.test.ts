// Sign-in helpers that need no database.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyRequest } from "fastify";
import { addressKey, clientAddress } from "../src/auth.ts";

test("the per-network sign-in limit counts IPv4 addresses one by one and IPv6 by /64", () => {
  assert.equal(addressKey("203.0.113.7"), "203.0.113.7");
  assert.equal(addressKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(addressKey("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(addressKey("2001:0DB8:0001:0002::9"), "2001:db8:1:2::/64");
  assert.equal(addressKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(addressKey("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(addressKey("::1"), "0:0:0:0::/64");
});

test("CF-Connecting-IP counts only when the request came from a Cloudflare address", () => {
  const req = (ip: string, cf?: string) => ({ ip, headers: cf ? { "cf-connecting-ip": cf } : {} }) as unknown as FastifyRequest;
  assert.equal(clientAddress(req("172.69.74.222", "198.51.100.7")), "198.51.100.7");
  assert.equal(clientAddress(req("::ffff:104.16.1.1", "198.51.100.7")), "198.51.100.7");
  assert.equal(clientAddress(req("2606:4700:3037::1", "2001:db8::9")), "2001:db8::9");
  assert.equal(clientAddress(req("203.0.113.7", "198.51.100.7")), "203.0.113.7", "not Cloudflare: the header is ignored");
  assert.equal(clientAddress(req("172.69.74.222", "not-an-ip")), "172.69.74.222");
  assert.equal(clientAddress(req("172.69.74.222")), "172.69.74.222");
  assert.equal(clientAddress(req("172.18.0.5", "198.51.100.7")), "172.18.0.5", "a private address isn't Cloudflare");
});
