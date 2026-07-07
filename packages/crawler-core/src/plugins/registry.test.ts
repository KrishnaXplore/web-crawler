import { describe, it, expect } from "vitest";
import { runPlugins, availablePlugins } from "./registry.js";

const html = `<html><head>
  <title>My Page</title>
  <meta name="description" content="d">
  <meta name="generator" content="WordPress 6.4">
  <script src="/wp-includes/js/jquery.min.js"></script>
</head><body>
  <h1>One</h1>
  <img src="a.png" alt="ok"><img src="b.png">
</body></html>`;

describe("runPlugins", () => {
  it("returns null when no plugins requested", () => {
    expect(runPlugins([], { url: "http://a.com", html, headers: {}, status: 200 })).toBeNull();
  });

  it("runs seo, tech, security and keys output by name", () => {
    const out = runPlugins(["seo", "tech", "security"], {
      url: "http://a.com",
      html,
      headers: { "strict-transport-security": "max-age=1", "x-frame-options": "DENY" },
      status: 200,
    })!;
    expect(out.seo).toMatchObject({ h1Count: 1, images: 2, imagesMissingAlt: 1, hasMetaDescription: true });
    expect(out.tech).toMatchObject({ detected: expect.arrayContaining(["WordPress", "jQuery"]) });
    expect(out.security).toMatchObject({ score: "2/5" });
  });

  it("skips unknown plugin names", () => {
    const out = runPlugins(["nope"], { url: "http://a.com", html, headers: {}, status: 200 })!;
    expect(out).toEqual({});
  });

  it("exposes available plugin names", () => {
    expect(availablePlugins()).toEqual(expect.arrayContaining(["seo", "tech", "security"]));
  });
});
