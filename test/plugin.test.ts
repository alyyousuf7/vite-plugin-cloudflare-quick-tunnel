import { resolveConfig, type UserConfig } from "vite";
import { describe, expect, it } from "vitest";

import cloudflareQuickTunnel from "../src/index.js";

const resolve = (config: Pick<UserConfig, "server" | "preview"> = {}) =>
  resolveConfig(
    {
      configFile: false,
      logLevel: "silent",
      plugins: [cloudflareQuickTunnel({ autoStart: false })],
      ...config,
    },
    "serve",
  );

describe("cloudflareQuickTunnel plugin", () => {
  it("only applies to serve (dev and preview)", () => {
    const plugin = cloudflareQuickTunnel();
    expect(plugin.name).toBe("cloudflare-quick-tunnel");
    expect(plugin.apply).toBe("serve");
  });

  it("allows the tunnel hostname when allowedHosts is unset", async () => {
    const config = await resolve();
    expect(config.server.allowedHosts).toContain(".trycloudflare.com");
  });

  it("appends the tunnel hostname to a user-provided allowedHosts list", async () => {
    const config = await resolve({ server: { allowedHosts: [".localhost", ".ngrok.app"] } });
    expect(config.server.allowedHosts).toEqual([".localhost", ".ngrok.app", ".trycloudflare.com"]);
  });

  it("leaves allowedHosts: true untouched", async () => {
    const config = await resolve({ server: { allowedHosts: true } });
    expect(config.server.allowedHosts).toBe(true);
  });

  it("covers preview through server.allowedHosts inheritance when preview.allowedHosts is unset", async () => {
    const config = await resolve();
    expect(config.preview.allowedHosts).toContain(".trycloudflare.com");
  });

  it("appends the tunnel hostname to a user-provided preview.allowedHosts list", async () => {
    const config = await resolve({ preview: { allowedHosts: [".example.com"] } });
    expect(config.preview.allowedHosts).toEqual([".example.com", ".trycloudflare.com"]);
  });

  it("leaves preview.allowedHosts: true untouched", async () => {
    const config = await resolve({ preview: { allowedHosts: true } });
    expect(config.preview.allowedHosts).toBe(true);
  });
});
