/** The slice of a Vite dev server that target resolution needs (kept
 * structural so it fits http and http2 servers alike). */
export interface TargetServer {
  httpServer: {
    listening: boolean;
    once(event: "listening" | "close", listener: () => void): unknown;
    address(): string | { address: string; port: number } | null;
  } | null;
  config: { server: { port?: number } };
}

/**
 * Resolve the local origin for the tunnel to dial. Waits until the HTTP
 * server has bound its port — when the configured port is taken Vite falls
 * back to another one, and only the bound address tells us which. Returns
 * undefined when the server shuts down before ever listening.
 */
export async function resolveTunnelTarget(server: TargetServer): Promise<string | undefined> {
  const httpServer = server.httpServer;
  if (httpServer && !httpServer.listening) {
    const closedBeforeListening = await new Promise<boolean>((resolve) => {
      httpServer.once("listening", () => resolve(false));
      httpServer.once("close", () => resolve(true));
    });
    if (closedBeforeListening) return undefined;
  }

  const address = httpServer?.address();
  const bound = typeof address === "object" && address !== null ? address : undefined;
  const port = bound?.port ?? server.config.server.port;
  // Wildcard binds aren't dialable targets for cloudflared – use loopback
  const host = bound === undefined || bound.address === "::" || bound.address === "0.0.0.0" ? "localhost" : bound.address;
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/**
 * Append Vite's base to the tunnel URL the way Vite renders its own URLs:
 * the root base keeps its trailing slash, non-root bases are shown without one.
 */
export function formatTunnelUrl(url: string, base: string): string {
  return url + (base.replace(/\/$/, "") || "/");
}
