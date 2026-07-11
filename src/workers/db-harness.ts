import { Worker } from "worker_threads";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import { IpcRequest, IpcResponse } from "./protocol";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  method: string;
  args: any[];
}

export class DbHarness {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();
  private workerPath: string;
  private dbPath: string;
  private isShuttingDown = false;

  constructor(dbPath: string = "agentmailbox.db") {
    this.dbPath = dbPath;
    
    // In ts-node / vite environments, we can run TS files directly. 
    // In built environments, it might be a JS file.
    // We try to load the typescript file via a lightweight wrapper if running ts-node/tsx,
    // or just pass the path. We will pass __filename to auto-detect the extension.
    this.workerPath = path.join(__dirname, "sqlite-worker.ts");
    
    // If we're executing compiled JS, __dirname will point to the dist/workers folder and the file is .js
    if (__filename.endsWith(".js")) {
      this.workerPath = path.join(__dirname, "sqlite-worker.js");
    }

    this.spawnWorker();
  }

  private spawnWorker() {
    if (this.isShuttingDown) return;

    // Use ts-node/register or tsx if we are running .ts file directly
    let execArgv: string[] = [];
    if (this.workerPath.endsWith(".ts")) {
      execArgv = ["-r", "ts-node/register"];
    }

    this.worker = new Worker(this.workerPath, {
      workerData: { path: this.dbPath },
      execArgv,
    });

    this.worker.on("message", (res: IpcResponse) => {
      const pending = this.pending.get(res.id);
      if (!pending) return;

      this.pending.delete(res.id);

      if (res.error) {
        const err = new Error(res.error.message);
        err.name = res.error.name;
        err.stack = res.error.stack;
        pending.reject(err);
      } else {
        pending.resolve(res.result);
      }
    });

    this.worker.on("error", (err) => {
      console.error("[DbHarness] Worker error:", err);
      this.respawn();
    });

    this.worker.on("exit", (code) => {
      if (code !== 0 && !this.isShuttingDown) {
        console.error(`[DbHarness] Worker stopped with exit code ${code}`);
        this.respawn();
      }
    });
  }

  private respawn() {
    console.warn("[DbHarness] Respawing database worker...");
    if (this.worker) {
      this.worker.removeAllListeners();
      this.worker.terminate().catch(() => {});
    }
    
    // Reject all pending requests that were flying when it crashed
    for (const [id, req] of this.pending.entries()) {
      req.reject(new Error("Worker crashed before completing the request"));
    }
    this.pending.clear();

    this.spawnWorker();
  }

  public async call(method: string, ...args: any[]): Promise<any> {
    if (!this.worker) {
      throw new Error("Worker is not available");
    }
    
    return new Promise((resolve, reject) => {
      const id = uuidv4();
      this.pending.set(id, { resolve, reject, method, args });
      
      const req: IpcRequest = { id, method, args };
      this.worker!.postMessage(req);
    });
  }

  public async close(): Promise<void> {
    this.isShuttingDown = true;
    const worker = this.worker;
    if (worker) {
      const exited = new Promise<void>((resolve) => {
        worker.once("exit", () => resolve());
      });
      try {
        await this.call("close");
        await exited;
      } catch {
        await worker.terminate().catch(() => undefined);
      } finally {
        this.worker = null;
      }
    }
  }
}
