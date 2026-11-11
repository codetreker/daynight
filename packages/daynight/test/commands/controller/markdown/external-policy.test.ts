import { expect, test } from "vitest";
import { isPublicImageAddress, parseExternalImageUrl, copyExternalImage } from "../../../../src/commands/controller/markdown/external-source.js";

test("unknown deployment policy rejects before parsing or network access", async () => {
  await expect(copyExternalImage({ url: "https://example.com/image.png", outputPath: "/does-not-exist" })).rejects.toMatchObject({ code: "policy_restricted" });
});

test("the published address policy rejects special-use addresses including globally reachable assignments", () => {
  const forbidden = ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.0.0.9", "192.31.196.1", "192.52.193.1", "192.88.99.1", "192.168.0.1", "192.175.48.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "64:ff9b::808:808", "64:ff9b:1::1", "100::1", "100:0:0:1::1", "2001:1::1", "2001:db8::1", "2002:808:808::1", "2620:4f:8000::1", "3fff::1", "5f00::1", "fc00::1", "fe80::1", "ff02::1", "fe80::1%lo0"];
  for (const address of forbidden) expect(isPublicImageAddress(address), address).toBe(false);
  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.215.14", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicImageAddress(address), address).toBe(true);
});

test("URL parsing rejects ambiguous and credential-bearing locators before network", () => {
  for (const value of ["//example.com/a", "http:example.com/a", "https:///example.com/a", "https://user:pass@example.com/a", "https://%75ser@example.com/a", "https://example.com\\evil/a", "https://example.com:0/a", "https://example.com:65536/a", "https://localhost/a", "https://foo.localhost/a", "https://host.local/a", "https://metadata.google.internal/a", "http://2130706433/a", "http://0177.0.0.1/a", "http://[::1]/a", "http://example.com/\nsecret"]) expect(() => parseExternalImageUrl(value), value).toThrow();
  const url = parseExternalImageUrl("HTTPS://BÜCHER.example.:443/a%2Fb?sig=x%2Fy#fragment");
  expect(url.hostname).toBe("xn--bcher-kva.example");
  expect(url.pathname + url.search).toBe("/a%2Fb?sig=x%2Fy");
});
