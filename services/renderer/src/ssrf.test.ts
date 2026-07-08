import { describe, it, expect } from "vitest";
import { isRequestAllowed } from "./ssrf.js";

describe("isRequestAllowed (M9 renderer request vetting)", () => {
  it("blocks literal private / loopback / metadata IPs", async () => {
    expect(await isRequestAllowed("http://127.0.0.1/")).toBe(false);
    expect(await isRequestAllowed("http://10.0.0.5/")).toBe(false);
    expect(await isRequestAllowed("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(await isRequestAllowed("http://[::1]/")).toBe(false);
  });

  it("blocks non-http(s) network schemes but allows browser-internal ones", async () => {
    expect(await isRequestAllowed("ftp://example.com/")).toBe(false);
    expect(await isRequestAllowed("file:///etc/passwd")).toBe(false);
    expect(await isRequestAllowed("data:text/html,<h1>x</h1>")).toBe(true);
    expect(await isRequestAllowed("about:blank")).toBe(true);
  });

  it("refuses a malformed URL", async () => {
    expect(await isRequestAllowed("not a url")).toBe(false);
  });

  it("allows a public literal IP", async () => {
    expect(await isRequestAllowed("http://93.184.216.34/")).toBe(true);
  });
});
