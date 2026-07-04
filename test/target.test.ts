import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { formatTunnelUrl, resolveTunnelTarget, type TargetServer } from "../src/target.js";

const servers: Server[] = [];

const httpServer = (): Server => {
  const server = createServer();
  servers.push(server);
  return server;
};

const listen = (server: Server, host?: string): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, host, () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

const targetServer = (server: Server | null, port?: number): TargetServer => ({
  httpServer: server,
  config: { server: port === undefined ? {} : { port } },
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("resolveTunnelTarget", () => {
  it("uses the bound port of a listening server", async () => {
    const server = httpServer();
    const port = await listen(server);
    await expect(resolveTunnelTarget(targetServer(server))).resolves.toBe(`http://localhost:${port}`);
  });

  it("maps wildcard binds to localhost", async () => {
    const server = httpServer();
    const port = await listen(server, "0.0.0.0");
    await expect(resolveTunnelTarget(targetServer(server))).resolves.toBe(`http://localhost:${port}`);
  });

  it("keeps explicit non-wildcard binds", async () => {
    const server = httpServer();
    const port = await listen(server, "127.0.0.1");
    await expect(resolveTunnelTarget(targetServer(server))).resolves.toBe(`http://127.0.0.1:${port}`);
  });

  it("brackets IPv6 hosts", async () => {
    const server = httpServer();
    const port = await listen(server, "::1");
    await expect(resolveTunnelTarget(targetServer(server))).resolves.toBe(`http://[::1]:${port}`);
  });

  it("waits for the server to bind before resolving", async () => {
    const server = httpServer();
    const pending = resolveTunnelTarget(targetServer(server, 1234));
    const port = await listen(server);
    // resolves with the actually bound port, not the configured one
    await expect(pending).resolves.toBe(`http://localhost:${port}`);
  });

  it("resolves undefined when the server closes before listening", async () => {
    const server = httpServer();
    const pending = resolveTunnelTarget(targetServer(server));
    server.emit("close");
    await expect(pending).resolves.toBeUndefined();
  });

  it("falls back to the configured port in middleware mode", async () => {
    await expect(resolveTunnelTarget(targetServer(null, 8080))).resolves.toBe("http://localhost:8080");
  });
});

describe("formatTunnelUrl", () => {
  const url = "https://example.trycloudflare.com";

  it("keeps the trailing slash for the root base", () => {
    expect(formatTunnelUrl(url, "/")).toBe(`${url}/`);
  });

  it("appends a non-root base without a trailing slash", () => {
    expect(formatTunnelUrl(url, "/my-app")).toBe(`${url}/my-app`);
    expect(formatTunnelUrl(url, "/my-app/")).toBe(`${url}/my-app`);
  });
});
