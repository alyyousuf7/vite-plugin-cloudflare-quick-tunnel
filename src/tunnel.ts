import { Tunnel, use } from "cloudflared";

import { ensureCloudflared } from "./cloudflared.js";

/** How long cloudflared gets to report its public URL before we give up. */
const TUNNEL_URL_TIMEOUT_MS = 30_000;

// Cloudflare rejects a quick-tunnel request with an `error code: NNN[NN]`
// body (https://developers.cloudflare.com/support/troubleshooting/http-status-codes);
// these are the ones that can realistically hit the tunnel creation request —
// anything else (52x origin errors, 5-digit API codes, ...) gets the fallback.
const CLOUDFLARE_ERRORS: Record<string, string> = {
  1005: "your network's ASN is banned by Cloudflare",
  1006: "your IP address has been banned by Cloudflare",
  1007: "your IP address has been banned by Cloudflare",
  1008: "your IP address has been banned by Cloudflare",
  1009: "your country or region is banned by Cloudflare",
  1012: "access denied by Cloudflare",
  1015: "you are being rate limited; try again in a few minutes",
  1020: "access denied by a Cloudflare firewall rule",
  1025: "Cloudflare asks to check back later",
  1106: "your IP address has been banned by Cloudflare",
};

export interface TunnelLogger {
  info(message: string): void;
  debug(...args: unknown[]): void;
}

/** A single cloudflared quick-tunnel process. */
export class QuickTunnel {
  #tunnel: Tunnel | undefined;
  #url: string | undefined;
  #target: string | undefined;

  /** Public *.trycloudflare.com URL, once the tunnel is up. */
  get url(): string | undefined {
    return this.#url;
  }

  isOpen(): boolean {
    const child = this.#tunnel?.process;
    return child !== undefined && child.exitCode === null && !child.killed && this.#url !== undefined;
  }

  /** Whether an open tunnel is already pointing at the given local origin. */
  isOpenFor(target: string): boolean {
    return this.isOpen() && this.#target === target;
  }

  /** Spawn cloudflared against `target` and resolve with the public URL. */
  async open(target: string, log: TunnelLogger, extraArgs: readonly string[] = []): Promise<string> {
    this.close();

    use(await ensureCloudflared(log));
    const tunnel = new Tunnel(["tunnel", "--no-autoupdate", "--url", target, ...extraArgs]);
    log.debug(`cloudflared started (PID: ${tunnel.process.pid})`);
    const logOutput = (stream: "stdout" | "stderr") => (output: string) => {
      const indented = output
        .trimEnd()
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n");
      log.debug(`cloudflared ${stream}:\n${indented}`);
    };
    tunnel.on("stdout", logOutput("stdout"));
    tunnel.on("stderr", logOutput("stderr"));
    // A lifetime error listener — an unhandled 'error' event would crash the process
    tunnel.on("error", (error) => log.debug(`cloudflared error: ${error.message}`));
    tunnel.once("connected", (connection) => log.debug(`tunnel connection registered (${connection.location})`));
    this.#tunnel = tunnel;
    this.#target = target;

    this.#url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.close();
        reject(new Error(`cloudflared did not report a tunnel URL within ${TUNNEL_URL_TIMEOUT_MS / 1000}s`));
      }, TUNNEL_URL_TIMEOUT_MS);
      tunnel.once("url", (url) => {
        clearTimeout(timeout);
        resolve(url);
      });
      // cloudflared logs Cloudflare rejections to stderr and silently retries
      // instead of emitting an error — fail fast with a clear message
      tunnel.on("stderr", (output) => {
        const code = /error code:\s*(\d{3,5})\b/i.exec(output)?.[1];
        if (code === undefined) return;
        clearTimeout(timeout);
        this.close();
        const reason = CLOUDFLARE_ERRORS[code] ?? "see https://developers.cloudflare.com/support/troubleshooting/http-status-codes";
        reject(new Error(`Cloudflare rejected the quick tunnel request (error ${code}: ${reason})`));
      });
      tunnel.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      tunnel.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited before reporting a tunnel URL (code ${code})`));
      });
    });
    return this.#url;
  }

  /** Terminate the tunnel process (escalating to SIGKILL if it lingers). */
  close(): void {
    const tunnel = this.#tunnel;
    this.#tunnel = undefined;
    this.#url = undefined;
    this.#target = undefined;
    if (!tunnel) return;

    const child = tunnel.process;
    if (child.killed || child.exitCode !== null) return;
    tunnel.stop();
    const forceKill = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2_000);
    forceKill.unref();
    child.once("exit", () => clearTimeout(forceKill));
  }
}

// Vite config reloads re-evaluate this module in the same Node process, so
// the singleton lives on globalThis for the running tunnel to be re-used
// rather than duplicated.
const TUNNEL_KEY = Symbol.for("vite-plugin-cloudflare-quick-tunnel:tunnel");

export function getQuickTunnel(): QuickTunnel {
  const holder = globalThis as Record<symbol, unknown>;
  if (holder[TUNNEL_KEY] === undefined) {
    const tunnel = new QuickTunnel();
    process.once("exit", () => tunnel.close());
    holder[TUNNEL_KEY] = tunnel;
  }
  return holder[TUNNEL_KEY] as QuickTunnel;
}
