import { inspect } from "node:util";

import pc from "picocolors";
import { gte } from "semver";
import { createLogger, version as viteVersion, type Plugin, type ResolvedConfig } from "vite";

import { formatTunnelUrl, resolveTunnelTarget, type TargetServer } from "./target.js";
import { getQuickTunnel } from "./quick-tunnel.js";

export interface CloudflareQuickTunnelOptions {
  /**
   * Whether to start the tunnel automatically with the server. When set
   * to `false` no tunnel is started (and cloudflared is not downloaded) at
   * startup, but the `t + enter` shortcut can still open one on demand.
   * @default true
   */
  autoStart?: boolean;

  /**
   * Key for the tunnel toggle shortcut (`<key> + enter`). Pick one that
   * doesn't clash with Vite's built-in shortcuts (`r`, `u`, `o`, `c`, `q`,
   * `h`) — a custom shortcut takes precedence over a built-in on the same
   * key. Set to `false` to disable the shortcut.
   * @default "t"
   */
  shortcutKey?: string | false;

  /**
   * Relay cloudflared's own output and extra plugin diagnostics.
   * @default false
   */
  debug?: boolean;

  /**
   * Extra CLI arguments appended to the `cloudflared tunnel` invocation —
   * e.g. `["--edge-ip-version", "4"]` on networks with broken IPv6.
   * See `cloudflared tunnel --help` for the full list.
   * @default []
   */
  cloudflaredArgs?: string[];
}

/**
 * Cap on delaying Vite's URL-block print while waiting for the tunnel URL;
 * on timeout the block prints without it and the URL is announced once ready.
 */
const PRINT_GATE_TIMEOUT_MS = 10_000;

const PUBLIC_HOST_SUFFIX = ".trycloudflare.com";

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Vite < 7.2.7 doesn't merge repeated bindCLIShortcuts() calls — a second
// call double-registers stdin handling — so the shortcut is skipped there
const supportsCustomShortcuts = gte(viteVersion, "7.2.7");

/** The slice of a server the plugin drives (kept structural so both
 * ViteDevServer and PreviewServer fit). */
interface TunnelServer extends TargetServer {
  config: ResolvedConfig;
  printUrls(): void;
  bindCLIShortcuts(options?: {
    print?: boolean;
    customShortcuts?: { key: string; description: string; action?(server: never): void | Promise<void> }[];
  }): void;
}

/**
 * Exposes the Vite dev or preview server through a Cloudflare quick tunnel:
 * a random, public *.trycloudflare.com URL — no Cloudflare account, token,
 * or wrangler config needed. The URL is printed inside Vite's URL block, and
 * the `t + enter` shortcut opens/closes the tunnel at runtime.
 */
export function cloudflareQuickTunnel(options: CloudflareQuickTunnelOptions = {}): Plugin {
  const { autoStart = true, shortcutKey = "t", debug = false, cloudflaredArgs = [] } = options;
  const tunnel = getQuickTunnel();

  // Event messages styled like Vite's own timestamped lines. `timestamp` is
  // a per-call option (not a createLogger one), hence the wrapper; `debug`
  // goes through info, as Vite loggers have no debug level.
  const logger = createLogger("info", { prefix: "[cloudflare]" });
  const log = {
    info(message: string) {
      logger.info(message, { timestamp: true });
    },
    warn(message: string) {
      logger.warn(message, { timestamp: true });
    },
    error(message: string) {
      logger.error(message, { timestamp: true });
    },
    debug(...args: unknown[]) {
      if (!debug) return;
      const message = args.map((arg) => (typeof arg === "string" ? arg : inspect(arg))).join(" ");
      logger.info(message, { timestamp: true });
    },
  };

  /**
   * Start (or re-use) the tunnel for the given server. Resolves to true
   * when a new tunnel was started.
   */
  const startTunnel = async (server: TunnelServer): Promise<boolean> => {
    const target = await resolveTunnelTarget(server);
    if (target === undefined) return false;
    if (tunnel.isOpenFor(target)) {
      log.info("re-using existing tunnel");
      return false;
    }
    log.info("starting quick tunnel...");
    log.warn("the tunnel makes this server publicly reachable — anyone with the URL can access it");
    await tunnel.open(target, log, cloudflaredArgs);
    return true;
  };

  // ---------------------------------------------------------------------
  // CLI UX: tunnel URL in Vite's URL block and a `t + enter` shortcut.
  // ---------------------------------------------------------------------

  // Before the first URL-block print the tunnel URL is included in the block
  // itself; after it, the URL is announced standalone.
  let hasPrintedUrls = false;

  // Delays the URL-block print (and the shortcut hint line) until the tunnel
  // URL is known; stays resolved when the tunnel doesn't auto-start.
  let printGate: Promise<unknown> = Promise.resolve();

  /** Print the tunnel URL styled like Vite's own URL lines (base included). */
  const logTunnelUrl = (server: TunnelServer) => {
    if (tunnel.url === undefined) return;
    server.config.logger.info(
      `  ${pc.green("➜")}  ${pc.bold("Tunnel:")}  ${pc.cyan(formatTunnelUrl(tunnel.url, server.config.base))}`,
    );
  };

  /** Append the tunnel URL to Vite's URL block whenever it is (re)printed. */
  const patchPrintUrls = (server: TunnelServer) => {
    const printUrls = server.printUrls.bind(server);
    server.printUrls = () => {
      void printGate.then(() => {
        printUrls();
        logTunnelUrl(server);
        hasPrintedUrls = true;
      });
    };
  };

  /** Register the `<shortcutKey> + enter` shortcut to open/close the tunnel at runtime. */
  const bindTunnelShortcut = (server: TunnelServer) => {
    if (shortcutKey === false || !supportsCustomShortcuts || !process.stdin.isTTY || process.env.CI) return;

    const bindCLIShortcuts = server.bindCLIShortcuts.bind(server);
    server.bindCLIShortcuts = (shortcutsOptions) => {
      // Deferred on the same gate as printUrls so the hint line (printed by
      // Vite's CLI calling this with `print: true`) stays below the URL block
      void printGate.then(() => {
        if (shortcutsOptions?.print) {
          server.config.logger.info(
            pc.dim(pc.green("  ➜")) +
              pc.dim("  press ") +
              pc.bold(`${shortcutKey} + enter`) +
              pc.dim(" to start or close tunnel"),
          );
        }
        bindCLIShortcuts(shortcutsOptions);
      });
    };

    server.bindCLIShortcuts({
      customShortcuts: [
        {
          key: shortcutKey,
          description: "start or close tunnel",
          action: async () => {
            if (tunnel.isOpen()) {
              tunnel.close();
              log.info("tunnel closed");
              return;
            }
            try {
              if (await startTunnel(server)) {
                // Like Vite's `u` shortcut: re-print the whole URL block
                server.config.logger.info("");
                server.printUrls();
              }
            } catch (error) {
              log.error(`failed to start tunnel: ${errorMessage(error)}`);
            }
          },
        },
      ],
    });
  };

  const setupServer = (server: TunnelServer) => {
    patchPrintUrls(server);
    bindTunnelShortcut(server);
    if (!autoStart) return;

    const startedPromise = startTunnel(server)
      .then((startedNewTunnel) => {
        if (startedNewTunnel && hasPrintedUrls) {
          server.config.logger.info("");
          logTunnelUrl(server);
        }
      })
      .catch((error: unknown) => {
        log.error(`failed to start tunnel: ${errorMessage(error)}`);
      });

    printGate = Promise.race([startedPromise, new Promise((resolve) => setTimeout(resolve, PRINT_GATE_TIMEOUT_MS))]);
  };

  return {
    name: "cloudflare-quick-tunnel",
    apply: "serve",

    config(config) {
      // Accept requests arriving through the tunnel's public hostname
      config.server ??= {};
      const { allowedHosts } = config.server;
      if (allowedHosts === undefined) {
        config.server.allowedHosts = [PUBLIC_HOST_SUFFIX];
      } else if (Array.isArray(allowedHosts) && !allowedHosts.includes(PUBLIC_HOST_SUFFIX)) {
        allowedHosts.push(PUBLIC_HOST_SUFFIX);
      }

      // preview.allowedHosts falls back to server.allowedHosts when unset, so
      // only an explicit preview list needs the tunnel hostname appended
      const previewAllowedHosts = config.preview?.allowedHosts;
      if (Array.isArray(previewAllowedHosts) && !previewAllowedHosts.includes(PUBLIC_HOST_SUFFIX)) {
        previewAllowedHosts.push(PUBLIC_HOST_SUFFIX);
      }
    },

    configureServer: setupServer,
    configurePreviewServer: setupServer,
  };
}

export default cloudflareQuickTunnel;
