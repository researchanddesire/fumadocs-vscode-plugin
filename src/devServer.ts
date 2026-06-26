import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";

/** Reports a human-readable phase while the server is being prepared. */
export type ProgressFn = (phase: string) => void;

const MAX_LOG_CHARS = 16_000;

/**
 * Owns the lifecycle of a single bundled Fumadocs `next dev` server.
 *
 * Next.js 16 allows only one dev server per project directory, so we run
 * exactly one server and switch the previewed content root at runtime via a
 * state file (`.preview-state.json`) that the renderer reads on every request.
 * Dependencies are installed on demand from the shipped lockfile — we never
 * bundle `node_modules`.
 */
export class DevServerManager {
  private proc: cp.ChildProcess | undefined;
  private baseUrl: string | undefined;
  private starting: Promise<string> | undefined;
  private installPromise: Promise<void> | undefined;
  private readonly output: vscode.OutputChannel;
  private readonly statePath: string;
  private readonly pidPath: string;
  /** Rolling tail of recent output, surfaced in the preview's error view. */
  private logBuffer = "";

  constructor(
    private readonly webappDir: string,
    output: vscode.OutputChannel,
  ) {
    this.output = output;
    this.statePath = path.join(this.webappDir, ".preview-state.json");
    this.pidPath = path.join(this.webappDir, ".preview-server.pid");
  }

  /** The recent server/install output, for display in a debugging dropdown. */
  getRecentLogs(): string {
    return this.logBuffer.trimStart();
  }

  /** Append to the output channel and keep a capped copy for the error view. */
  private record(text: string): void {
    this.output.append(text);
    this.logBuffer += text;
    if (this.logBuffer.length > MAX_LOG_CHARS) {
      this.logBuffer = this.logBuffer.slice(this.logBuffer.length - MAX_LOG_CHARS);
    }
  }

  private recordLine(text: string): void {
    this.record(`${text}\n`);
  }

  /**
   * Point the (single) server at `root`, starting it if needed, and return its
   * base URL. Safe to call concurrently — starts are de-duplicated.
   */
  async ensure(root: string, onProgress?: ProgressFn): Promise<string> {
    this.writeState(root);

    if (this.baseUrl && this.proc && this.proc.exitCode === null) {
      onProgress?.("Reusing the running preview server");
      return this.baseUrl;
    }
    if (this.starting) {
      onProgress?.("Waiting for the preview server that is already starting…");
      return this.starting;
    }

    const start = this.start(onProgress).catch((err) => {
      this.starting = undefined;
      throw err;
    });
    this.starting = start;
    this.baseUrl = await start;
    return this.baseUrl;
  }

  private async start(onProgress?: ProgressFn): Promise<string> {
    await this.ensureDependencies(onProgress);
    this.killStaleServer();

    const port = await findFreePort();
    const bin = this.nextBinary();
    onProgress?.(`Starting the Fumadocs dev server on port ${port}…`);
    this.recordLine(`[server] starting on :${port}`);

    const proc = cp.spawn(bin, ["dev", "-p", String(port), "-H", "127.0.0.1"], {
      cwd: this.webappDir,
      env: {
        ...process.env,
        BROWSER: "none",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    });
    this.proc = proc;
    this.writePid(proc.pid);

    proc.stdout?.on("data", (d) => this.record(`[next] ${d}`));
    proc.stderr?.on("data", (d) => this.record(`[next] ${d}`));
    proc.on("exit", (code) => {
      this.recordLine(`[server] exited (code ${code})`);
      if (this.proc === proc) {
        this.proc = undefined;
        this.baseUrl = undefined;
        this.starting = undefined;
      }
    });

    onProgress?.("Waiting for the preview server to become ready…");
    await waitForServer(port, proc);
    return `http://127.0.0.1:${port}`;
  }

  private nextBinary(): string {
    const binName = process.platform === "win32" ? "next.cmd" : "next";
    return path.join(this.webappDir, "node_modules", ".bin", binName);
  }

  private writeState(root: string): void {
    try {
      fs.writeFileSync(
        this.statePath,
        JSON.stringify({ root }, null, 2),
        "utf8",
      );
    } catch (err) {
      this.recordLine(`[state] failed to write root: ${String(err)}`);
    }
  }

  private writePid(pid: number | undefined): void {
    if (pid == null) return;
    try {
      fs.writeFileSync(this.pidPath, String(pid), "utf8");
    } catch {
      // best-effort
    }
  }

  /** Kill a server left behind by a previous window/session, if any. */
  private killStaleServer(): void {
    let pid: number | undefined;
    try {
      pid = Number.parseInt(fs.readFileSync(this.pidPath, "utf8").trim(), 10);
    } catch {
      return;
    }
    if (!pid || Number.isNaN(pid)) return;
    try {
      process.kill(pid, "SIGKILL");
      this.recordLine(`[server] killed stale server pid ${pid}`);
    } catch {
      // already gone
    }
    try {
      fs.unlinkSync(this.pidPath);
    } catch {
      // ignore
    }
  }

  private get dependenciesInstalled(): boolean {
    return fs.existsSync(path.join(this.webappDir, "node_modules", ".bin"));
  }

  private ensureDependencies(onProgress?: ProgressFn): Promise<void> {
    if (this.dependenciesInstalled) return Promise.resolve();
    if (this.installPromise) {
      onProgress?.("Waiting for renderer dependencies to finish installing…");
      return this.installPromise;
    }

    onProgress?.("Installing renderer dependencies (first run, this can take a minute)…");
    const install = Promise.resolve(
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title:
            "Fumadocs Preview: installing renderer dependencies (first run)…",
          cancellable: false,
        },
        () => this.runInstall(),
      ),
    );
    this.installPromise = install;
    return install;
  }

  private runInstall(): Promise<void> {
    const { command, args } = this.installCommand();
    this.recordLine(`[install] ${command} ${args.join(" ")}`);

    return new Promise<void>((resolve, reject) => {
      const proc = cp.spawn(command, args, {
        cwd: this.webappDir,
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
        shell: process.platform === "win32",
      });
      proc.stdout?.on("data", (d) => this.record(`[install] ${d}`));
      proc.stderr?.on("data", (d) => this.record(`[install] ${d}`));
      proc.on("error", reject);
      proc.on("exit", (code) => {
        if (code === 0 && this.dependenciesInstalled) {
          resolve();
        } else {
          reject(
            new Error(
              `Dependency install failed (exit ${code}). See the "Fumadocs Preview" output channel.`,
            ),
          );
        }
      });
    });
  }

  private installCommand(): { command: string; args: string[] } {
    const has = (file: string) =>
      fs.existsSync(path.join(this.webappDir, file));
    if (has("pnpm-lock.yaml")) {
      return { command: "pnpm", args: ["install", "--frozen-lockfile"] };
    }
    if (has("yarn.lock")) {
      return { command: "yarn", args: ["install", "--frozen-lockfile"] };
    }
    return { command: "npm", args: ["ci"] };
  }

  dispose(): void {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // ignore
      }
      this.proc = undefined;
    }
    try {
      fs.unlinkSync(this.pidPath);
    } catch {
      // ignore
    }
  }
}

/** Resolve once the server answers an HTTP request (any status), or reject. */
function waitForServer(port: number, proc: cp.ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for the preview server to start."));
    }, 90_000);

    const poll = async () => {
      if (proc.exitCode !== null || proc.killed) {
        clearTimeout(timeout);
        reject(new Error("Preview server exited before it became ready."));
        return;
      }
      try {
        await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD" });
        clearTimeout(timeout);
        resolve();
        return;
      } catch {
        setTimeout(poll, 400);
      }
    };
    setTimeout(poll, 600);
  });
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const { port } = address;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Could not allocate a port.")));
      }
    });
  });
}
