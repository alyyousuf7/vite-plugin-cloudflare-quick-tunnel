import { EventEmitter } from "node:events";
import { vi } from "vitest";

export class FakeChildProcess {
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

export class Tunnel extends EventEmitter {
  /**
   * Test-only registry (not part of the real cloudflared Tunnel API): every
   * Tunnel constructed so far, oldest first; tests reset it between runs.
   */
  static instances: Tunnel[] = [];

  args: string[];
  process = new FakeChildProcess();

  constructor(args: string[]) {
    super();
    this.args = args;
    Tunnel.instances.push(this);
  }

  stop() {
    this.process.kill("SIGINT");
    return true;
  }
}

export const use = vi.fn();
export const install = vi.fn();
