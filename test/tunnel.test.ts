import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getQuickTunnel, QuickTunnel, type TunnelLogger } from "../src/tunnel.js";

interface FakeChild {
  pid: number;
  exitCode: number | null;
  killed: boolean;
  signals: string[];
  kill(signal?: string): boolean;
  exit(code: number): void;
  once(event: string, listener: () => void): FakeChild;
}

interface FakeTunnel {
  args: string[];
  process: FakeChild;
  emit(event: string, ...eventArgs: unknown[]): boolean;
}

const state = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock("cloudflared", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeChildImpl {
    pid = 12345;
    exitCode: number | null = null;
    killed = false;
    signals: string[] = [];
    #events = new EventEmitter();

    kill(signal?: string) {
      this.signals.push(signal ?? "SIGTERM");
      return true;
    }

    exit(code: number) {
      this.exitCode = code;
      this.#events.emit("exit");
    }

    once(event: string, listener: () => void) {
      this.#events.once(event, listener);
      return this;
    }
  }

  class FakeTunnelImpl extends EventEmitter {
    args: string[];
    process = new FakeChildImpl();

    constructor(args: string[]) {
      super();
      this.args = args;
      state.instances.push(this);
    }

    stop() {
      this.process.kill("SIGINT");
      return true;
    }
  }

  return { Tunnel: FakeTunnelImpl, use: vi.fn(), install: vi.fn() };
});

vi.mock("../src/cloudflared.js", () => ({
  ensureCloudflared: vi.fn(async () => "/fake/cloudflared"),
}));

const log: TunnelLogger = { info: () => {}, debug: () => {} };

const lastTunnel = () => state.instances.at(-1) as FakeTunnel;

describe("QuickTunnel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns cloudflared with the target and extra args, resolving on the url event", async () => {
    const quickTunnel = new QuickTunnel();
    const pending = quickTunnel.open("http://localhost:5173", log, ["--edge-ip-version", "4"]);
    await vi.waitFor(() => expect(state.instances).toHaveLength(1));
    expect(lastTunnel().args).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--url",
      "http://localhost:5173",
      "--edge-ip-version",
      "4",
    ]);

    lastTunnel().emit("url", "https://random.trycloudflare.com");
    await expect(pending).resolves.toBe("https://random.trycloudflare.com");
    expect(quickTunnel.url).toBe("https://random.trycloudflare.com");
    expect(quickTunnel.isOpen()).toBe(true);
    expect(quickTunnel.isOpenFor("http://localhost:5173")).toBe(true);
    expect(quickTunnel.isOpenFor("http://localhost:9999")).toBe(false);
  });

  it("rejects when cloudflared exits before reporting a URL", async () => {
    const quickTunnel = new QuickTunnel();
    const pending = quickTunnel.open("http://localhost:5173", log);
    await vi.waitFor(() => expect(state.instances).toHaveLength(1));

    lastTunnel().process.exitCode = 1;
    lastTunnel().emit("exit", 1, null);
    await expect(pending).rejects.toThrow(/exited before reporting a tunnel URL/);
    expect(quickTunnel.isOpen()).toBe(false);
  });

  it("rejects fast when Cloudflare rate-limits the tunnel request", async () => {
    const quickTunnel = new QuickTunnel();
    const pending = quickTunnel.open("http://localhost:5173", log);
    await vi.waitFor(() => expect(state.instances).toHaveLength(1));

    // real cloudflared output, captured while rate-limited
    lastTunnel().emit("stderr", "2026-07-04T05:07:12Z ERR Error unmarshaling QuickTunnel response: error code: 1015");
    await expect(pending).rejects.toThrow(/error 1015: you are being rate limited/);
    expect(quickTunnel.isOpen()).toBe(false);
  });

  it.each(["520", "1034", "10015"])(
    "rejects with a generic message for the unmapped Cloudflare error code %s",
    async (code) => {
      const quickTunnel = new QuickTunnel();
      const pending = quickTunnel.open("http://localhost:5173", log);
      await vi.waitFor(() => expect(state.instances).toHaveLength(1));

      lastTunnel().emit("stderr", `ERR Error unmarshaling QuickTunnel response: error code: ${code}`);
      await expect(pending).rejects.toThrow(new RegExp(`error ${code}: see https://developers\\.cloudflare\\.com`));
    },
  );

  it("rejects when no URL appears within the timeout", async () => {
    const quickTunnel = new QuickTunnel();
    const pending = quickTunnel.open("http://localhost:5173", log);
    pending.catch(() => {}); // observed below; avoid unhandled-rejection noise
    await vi.waitFor(() => expect(state.instances).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).rejects.toThrow(/did not report a tunnel URL within/);
  });

  it("close() stops the process and escalates to SIGKILL if it lingers", async () => {
    const quickTunnel = new QuickTunnel();
    const pending = quickTunnel.open("http://localhost:5173", log);
    await vi.waitFor(() => expect(state.instances).toHaveLength(1));
    lastTunnel().emit("url", "https://random.trycloudflare.com");
    await pending;

    const child = lastTunnel().process;
    quickTunnel.close();
    expect(child.signals).toEqual(["SIGINT"]);
    expect(quickTunnel.isOpen()).toBe(false);
    expect(quickTunnel.url).toBeUndefined();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  it("close() does not escalate once the process has exited", async () => {
    const quickTunnel = new QuickTunnel();
    const pending = quickTunnel.open("http://localhost:5173", log);
    await vi.waitFor(() => expect(state.instances).toHaveLength(1));
    lastTunnel().emit("url", "https://random.trycloudflare.com");
    await pending;

    const child = lastTunnel().process;
    quickTunnel.close();
    child.exit(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.signals).toEqual(["SIGINT"]);
  });

  it("opening again closes the previous tunnel", async () => {
    const quickTunnel = new QuickTunnel();
    const first = quickTunnel.open("http://localhost:5173", log);
    await vi.waitFor(() => expect(state.instances).toHaveLength(1));
    lastTunnel().emit("url", "https://first.trycloudflare.com");
    await first;
    const firstChild = lastTunnel().process;

    const second = quickTunnel.open("http://localhost:8080", log);
    await vi.waitFor(() => expect(state.instances).toHaveLength(2));
    lastTunnel().emit("url", "https://second.trycloudflare.com");
    await second;

    expect(firstChild.signals).toContain("SIGINT");
    expect(quickTunnel.isOpenFor("http://localhost:8080")).toBe(true);
  });

  it("survives a late error event without crashing", async () => {
    const quickTunnel = new QuickTunnel();
    const pending = quickTunnel.open("http://localhost:5173", log);
    await vi.waitFor(() => expect(state.instances).toHaveLength(1));
    lastTunnel().emit("url", "https://random.trycloudflare.com");
    await pending;

    // An 'error' event without a listener would throw synchronously
    expect(() => lastTunnel().emit("error", new Error("late failure"))).not.toThrow();
  });
});

describe("getQuickTunnel", () => {
  it("returns the same instance across calls", () => {
    expect(getQuickTunnel()).toBe(getQuickTunnel());
  });
});
