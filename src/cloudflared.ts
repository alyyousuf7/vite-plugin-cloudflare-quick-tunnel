import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { install } from "cloudflared";

export interface CloudflaredLogger {
  info(message: string): void;
}

/** Where the downloaded binary lives (outside the project, shared across repos). */
export function cloudflaredPath(): string {
  const cacheRoot = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  const executable = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  return path.join(cacheRoot, "vite-plugin-cloudflare-quick-tunnel", executable);
}

/**
 * Make sure the cloudflared binary exists locally, downloading the latest
 * official release on first use (honouring the CLOUDFLARED_VERSION env var
 * to pin a specific one). Returns the binary path.
 */
export async function ensureCloudflared(log: CloudflaredLogger): Promise<string> {
  const binPath = cloudflaredPath();
  try {
    await access(binPath);
    return binPath;
  } catch {
    // not downloaded yet
  }

  log.info("downloading cloudflared...");
  await mkdir(path.dirname(binPath), { recursive: true });
  await install(binPath);

  const version = await new Promise<string | undefined>((resolve) => {
    execFile(binPath, ["--version"], (error, stdout) => resolve(error ? undefined : stdout.trim()));
  });
  if (version) log.info(version);
  return binPath;
}
