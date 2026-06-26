import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";

/** Reports a human-readable phase while the server is being prepared. */
export type ProgressFn = (phase: string) => void;

const MAX_LOG_CHARS = 16_000;

/** Where the user is sent to install Node.js (which bundles npm). */
const NODE_DOWNLOAD_URL = "https://nodejs.org/en/download";
/** Node.js help docs for getting a working package manager. */
const NODE_PM_HELP_URL = "https://nodejs.org/en/download/package-manager";
/** Lowest Node.js major version the bundled Next.js renderer supports. */
const MIN_NODE_MAJOR = 20;
/** Sharp's official install/troubleshooting docs. */
const SHARP_HELP_URL = "https://sharp.pixelplumbing.com/install";

/**
 * A preview failure caused by a missing/incompatible toolchain (Node.js or a
 * package manager). Carries a link the error view can surface so the user can
 * fix it without leaving the editor.
 */
export class ToolchainError extends Error {
  constructor(
    message: string,
    readonly helpUrl: string,
    readonly helpLabel: string,
  ) {
    super(message);
    this.name = "ToolchainError";
  }
}

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
  /** Active content root, persisted to the state file for the renderer. */
  private currentRoot: string | undefined;
  /** Live-edit overrides (abs path -> unsaved buffer content). */
  private overrides: Record<string, string> = {};
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
    this.currentRoot = root;
    this.writeState();

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
    await this.ensureNode(onProgress);
    await this.ensureDependencies(onProgress);
    await this.ensureSharp(onProgress);
    this.killStaleServer();

    const port = await this.resolvePort(onProgress);
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

  /**
   * Verify Node.js is on PATH and new enough to run the bundled renderer.
   * Throws a {@link ToolchainError} (with an install link) otherwise, so the
   * preview shows actionable instructions instead of a cryptic spawn failure.
   */
  private async ensureNode(onProgress?: ProgressFn): Promise<void> {
    onProgress?.("Checking for Node.js…");
    const version = await nodeVersion();
    if (version === null) {
      this.recordLine("[toolchain] Node.js was not found on PATH");
      throw new ToolchainError(
        "Node.js is required to run the Fumadocs preview, but it wasn't found on your PATH. Install Node.js (it includes npm), then restart the preview.",
        NODE_DOWNLOAD_URL,
        "Install Node.js",
      );
    }

    this.recordLine(`[toolchain] using Node.js ${version}`);
    const major = parseMajorVersion(version);
    if (major !== null && major < MIN_NODE_MAJOR) {
      throw new ToolchainError(
        `The Fumadocs preview needs Node.js ${MIN_NODE_MAJOR} or newer, but found ${version}. Update Node.js, then restart the preview.`,
        NODE_DOWNLOAD_URL,
        "Update Node.js",
      );
    }
  }

  private nextBinary(): string {
    const binName = process.platform === "win32" ? "next.cmd" : "next";
    return path.join(this.webappDir, "node_modules", ".bin", binName);
  }

  /** The user's preferred preview port (defaults to 6969). */
  private preferredPort(): number {
    const configured = vscode.workspace
      .getConfiguration("fumadocs")
      .get<number>("previewPort", 6969);
    return Number.isInteger(configured) && configured > 0 && configured < 65536
      ? configured
      : 6969;
  }

  /**
   * Decide which port to bind. Prefer the configured port. Any server we
   * previously started has already been killed via the PID file, so if the
   * preferred port is still busy it belongs to a *different* process — ask the
   * user whether to stop it or fall back to a free port. Never silently hop
   * ports.
   */
  private async resolvePort(onProgress?: ProgressFn): Promise<number> {
    const preferred = this.preferredPort();
    if (await isPortFree(preferred)) return preferred;

    onProgress?.(`Port ${preferred} is already in use…`);
    this.recordLine(`[server] port ${preferred} is in use by another process`);

    const stop = `Stop the process on port ${preferred}`;
    const fallback = "Use a different port";
    const choice = await vscode.window.showWarningMessage(
      `Port ${preferred} is already in use by another process (not the Fumadocs preview). How should the preview proceed?`,
      { modal: true },
      stop,
      fallback,
    );

    if (choice === stop) {
      onProgress?.(`Stopping the process on port ${preferred}…`);
      await this.killProcessOnPort(preferred);
      if (await isPortFree(preferred)) return preferred;
      throw new Error(
        `Port ${preferred} is still in use after attempting to stop the existing process.`,
      );
    }

    if (choice === fallback) {
      const port = await findFreePort();
      this.recordLine(`[server] falling back to free port :${port}`);
      return port;
    }

    throw new Error(
      `Port ${preferred} is in use. Preview cancelled — free the port or pick another in the "fumadocs.previewPort" setting.`,
    );
  }

  /** Best-effort kill of whatever process is listening on `port`. */
  private async killProcessOnPort(port: number): Promise<void> {
    const pids = await pidsOnPort(port);
    if (pids.length === 0) {
      this.recordLine(`[server] no process found listening on :${port}`);
      return;
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
        this.recordLine(`[server] killed process pid ${pid} on :${port}`);
      } catch (err) {
        this.recordLine(`[server] failed to kill pid ${pid}: ${String(err)}`);
      }
    }
    // Give the OS a moment to release the socket.
    await delay(300);
  }

  /** Stop the running server so the next `ensure()` starts a fresh one. */
  stop(): void {
    if (this.proc) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      this.proc = undefined;
    }
    this.baseUrl = undefined;
    this.starting = undefined;
    try {
      fs.unlinkSync(this.pidPath);
    } catch {
      // ignore
    }
    this.recordLine("[server] stopped (restart requested)");
  }

  /**
   * Replace the live-edit overrides (unsaved buffer contents, keyed by absolute
   * path) and persist them so the renderer picks them up on the next refresh.
   */
  setOverrides(overrides: Record<string, string>): void {
    this.overrides = overrides;
    this.writeState();
  }

  private writeState(): void {
    if (!this.currentRoot) return;
    try {
      fs.writeFileSync(
        this.statePath,
        JSON.stringify(
          { root: this.currentRoot, overrides: this.overrides },
          null,
          2,
        ),
        "utf8",
      );
    } catch (err) {
      this.recordLine(`[state] failed to write state: ${String(err)}`);
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
    // Reset the cached promise on failure so a retry (e.g. after the user
    // installs Node.js or a package manager) actually re-runs the install.
    const install = this.installDependencies().catch((err) => {
      this.installPromise = undefined;
      throw err;
    });
    this.installPromise = install;
    return install;
  }

  private async installDependencies(): Promise<void> {
    const { command, args } = this.installCommand();
    await this.ensurePackageManager(command);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title:
          "Fumadocs Preview: installing renderer dependencies (first run)…",
        cancellable: false,
      },
      () => this.runInstall(command, args),
    );
  }

  /**
   * Verify the package manager needed for the first-run install is on PATH.
   * Node.js bundles npm, so a missing npm usually means a broken/partial Node
   * install — point at the Node.js docs rather than failing opaquely.
   */
  private async ensurePackageManager(command: string): Promise<void> {
    if (await commandExists(command)) return;
    this.recordLine(`[toolchain] "${command}" was not found on PATH`);
    throw new ToolchainError(
      `Node.js is installed, but "${command}" — needed to install the preview's dependencies — wasn't found on your PATH.`,
      NODE_PM_HELP_URL,
      `How to set up ${command}`,
    );
  }

  /**
   * Verify the bundled `sharp` (pulled in by Next.js for image handling)
   * actually loads in the same Node.js that runs the dev server. A skipped
   * install script or a wrong-platform binary makes `require("sharp")` throw,
   * which otherwise surfaces as an opaque render failure. On failure we throw a
   * {@link ToolchainError} with platform-specific fix-it instructions.
   */
  private async ensureSharp(onProgress?: ProgressFn): Promise<void> {
    onProgress?.("Checking image support (sharp)…");
    const result = await probeSharp(this.webappDir);
    if (result.ok) {
      this.recordLine("[toolchain] sharp loaded successfully");
      return;
    }
    this.recordLine(`[toolchain] sharp failed to load:\n${result.error}`);
    throw new ToolchainError(
      sharpInstructions(this.webappDir),
      SHARP_HELP_URL,
      "Sharp install help",
    );
  }

  private runInstall(command: string, args: string[]): Promise<void> {
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
    // `next` pulls in `sharp`, which has a native install script. If the user
    // has `ignore-scripts=true` in their global ~/.npmrc (common on locked-down
    // Windows setups), that script is skipped and the preview fails to render
    // images. Force scripts on for this install so sharp's binary is fetched.
    return { command: "npm", args: ["ci", "--ignore-scripts=false"] };
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

/** True if `port` can be bound on 127.0.0.1 right now. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

/** PIDs of processes listening on `port` (best-effort, platform-specific). */
function pidsOnPort(port: number): Promise<number[]> {
  const isWin = process.platform === "win32";
  const command = isWin
    ? `netstat -ano -p tcp | findstr ":${port} "`
    : `lsof -nP -iTCP:${port} -sTCP:LISTEN -t`;
  return new Promise((resolve) => {
    cp.exec(command, { windowsHide: true }, (_err, stdout) => {
      resolve(parsePids(stdout ?? "", isWin));
    });
  });
}

/** Extract PIDs from `lsof -t` (unix) or `netstat -ano` (windows) output. */
function parsePids(text: string, isWin: boolean): number[] {
  const trailingPid = /(\d+)\s*$/;
  const tokens = isWin
    ? text.split(/\r?\n/).map((line) => trailingPid.exec(line.trim())?.[1])
    : text.split(/\s+/);
  const pids = new Set<number>();
  for (const token of tokens) {
    const pid = Number.parseInt(token ?? "", 10);
    if (pid > 0) pids.add(pid);
  }
  return [...pids];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve `node --version` (e.g. "v22.1.0"), or null if Node isn't runnable. */
function nodeVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    const proc = cp.spawn("node", ["--version"], {
      shell: process.platform === "win32",
      windowsHide: true,
    });
    proc.on("error", () => resolve(null));
    proc.stdout?.on("data", (d) => (out += String(d)));
    proc.on("exit", (code) => resolve(code === 0 ? out.trim() : null));
  });
}

/** Parse the major version from a `vX.Y.Z` string; null if unrecognized. */
function parseMajorVersion(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version.trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

/** True if `<command> --version` runs successfully (i.e. it's on PATH). */
function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = cp.spawn(command, ["--version"], {
      shell: process.platform === "win32",
      windowsHide: true,
    });
    proc.on("error", () => resolve(false));
    proc.on("exit", (code) => resolve(code === 0));
  });
}

/**
 * Try to load the webapp's `sharp` in a child `node` (the same runtime that
 * will run the dev server). Resolves ok=false with the captured error when the
 * native binding can't be loaded.
 */
function probeSharp(
  webappDir: string,
): Promise<{ ok: boolean; error: string }> {
  const sharpEntry = path.join(webappDir, "node_modules", "sharp");
  // Loading the module triggers the native binding load; that's the real test.
  const code = `require(${JSON.stringify(sharpEntry)});`;
  return new Promise((resolve) => {
    let err = "";
    const proc = cp.spawn("node", ["-e", code], {
      cwd: webappDir,
      windowsHide: true,
    });
    proc.on("error", (e) => resolve({ ok: false, error: String(e) }));
    proc.stderr?.on("data", (d) => (err += String(d)));
    proc.on("exit", (exitCode) =>
      resolve(
        exitCode === 0
          ? { ok: true, error: "" }
          : { ok: false, error: err.trim() || `node exited with code ${exitCode}` },
      ),
    );
  });
}

/** Platform-specific, copy-pasteable steps to repair a broken `sharp` install. */
function sharpInstructions(webappDir: string): string {
  const intro =
    "Image support (sharp) couldn't be loaded, so the Fumadocs preview can't render. ";
  const cd = `  cd "${webappDir}"`;
  if (process.platform === "win32") {
    return [
      intro,
      "On Windows this usually means the native binary was skipped by an `ignore-scripts` policy.",
      "",
      "Reinstall it with scripts and the platform binary enabled:",
      cd,
      "  npm install --ignore-scripts=false --include=optional sharp",
      "",
      "If you use @lavamoat/allow-scripts, also run:",
      "  npm config set allow-scripts=sharp --location=user",
      "",
      "Then restart the preview.",
    ].join("\n");
  }
  if (process.platform === "darwin") {
    return [
      intro,
      "On macOS this usually means the platform binary is missing (e.g. an x64/arm64 mismatch).",
      "",
      "Reinstall the optional platform binary:",
      cd,
      "  npm install --include=optional sharp",
      "",
      "On Apple Silicon, make sure Node.js isn't running under Rosetta (`node -p process.arch` should be \"arm64\").",
      "",
      "Then restart the preview.",
    ].join("\n");
  }
  return [
    intro,
    "On Linux this usually means the platform binary is missing for your C library (glibc vs musl).",
    "",
    "Reinstall the optional platform binary:",
    cd,
    "  npm install --include=optional sharp",
    "",
    "On Alpine/musl you may also need the system libvips:  apk add --no-cache vips",
    "",
    "Then restart the preview.",
  ].join("\n");
}
