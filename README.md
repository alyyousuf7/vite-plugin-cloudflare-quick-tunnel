# vite-plugin-cloudflare-quick-tunnel

Expose your Vite dev or preview server through a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/): a random, public `https://*.trycloudflare.com` URL. No Cloudflare account, API token, or wrangler config needed.

```
  VITE v7.3.1  ready in 1355 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.5:5173/
  ➜  Tunnel:  https://quarters-engagement-plastic-moments.trycloudflare.com/
  ➜  press t + enter to start or close tunnel
  ➜  press h + enter to show help
```

## Features

- **Tunnel URL in Vite's URL block** — printed alongside `Local:`/`Network:`, not as a stray log line.
- **`t + enter` shortcut** — open or close the tunnel at runtime (Vite ≥ 7.2.7; key configurable).
- **`autoStart: false`** — don't auto-start; the shortcut can still open a tunnel on demand.
- **Works with `vite dev` and `vite preview`** — share the dev server or a production build.
- **Self-contained** — downloads the latest official `cloudflared` binary on first use (via [node-cloudflared](https://github.com/JacobLinCool/node-cloudflared); pin a version with the `CLOUDFLARED_VERSION` env var), cached under `~/.cache` and shared across repos; tears the process down when the server exits.

## Usage

```ts
// vite.config.ts
import { defineConfig } from "vite";
import cloudflareQuickTunnel from "vite-plugin-cloudflare-quick-tunnel";

export default defineConfig({
  plugins: [
    // Start a tunnel automatically with the server:
    cloudflareQuickTunnel(),

    // Preferred: only open a tunnel on demand, with `t + enter`:
    // cloudflareQuickTunnel({ autoStart: false }),

    // Disable the plugin entirely — the plugin equivalent of buying
    // a treadmill to hang clothes on:
    // cloudflareQuickTunnel({ autoStart: false, shortcutKey: false }),
  ],
});
```

### Options

| Option            | Type              | Default | Description                                                                                                                                                                     |
| ----------------- | ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoStart`       | `boolean`         | `true`  | Start the tunnel automatically with the server. When `false`, no tunnel starts (and cloudflared isn't downloaded) until `t + enter`.                                            |
| `shortcutKey`     | `string \| false` | `"t"`   | Key for the tunnel toggle shortcut (`<key> + enter`). Pick one that doesn't clash with Vite's built-in shortcuts (`r`, `u`, `o`, `c`, `q`, `h`); `false` disables the shortcut. |
| `debug`           | `boolean`         | `false` | Relay cloudflared's own output and extra plugin diagnostics.                                                                                                                    |
| `cloudflaredArgs` | `string[]`        | `[]`    | Extra CLI arguments appended to the `cloudflared tunnel` invocation — e.g. `["--edge-ip-version", "4"]` on networks with broken IPv6. See `cloudflared tunnel --help`.          |

## Security note

A quick tunnel makes your **local server publicly reachable** — source modules, HMR, and any proxied backends included. Anyone with the URL can access it. Prefer `autoStart: false` and opening tunnels on demand, and close the tunnel with `t + enter` when you're done sharing.

## Limitations

- Quick tunnels only — no named tunnels, custom domains, or DNS/SSL management. Use Cloudflare's own tooling (or a named-tunnel plugin) for that.
- Quick tunnels don't support Server-Sent Events.
