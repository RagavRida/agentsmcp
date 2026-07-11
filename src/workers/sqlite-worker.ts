import { parentPort, workerData } from "worker_threads";
import { SqliteStorageBackend } from "../storage/sqlite-backend";
import { IpcRequest, IpcResponse } from "./protocol";

if (!parentPort) {
  throw new Error("This file must be run as a worker thread.");
}

// Instantiate the core backend
const path = workerData?.path || "agentmailbox.db";
const backend = new SqliteStorageBackend(path);

parentPort.on("message", async (req: IpcRequest) => {
  try {
    if (req.method === "close") {
      await backend.close();
      parentPort!.postMessage({ id: req.id, result: undefined } as IpcResponse);
      parentPort!.close();
      return;
    }

    // Determine the method to call
    const method = backend[req.method as keyof SqliteStorageBackend];
    if (typeof method !== "function") {
      throw new Error(`Method ${req.method} not found on SqliteStorageBackend`);
    }

    // Call it (all Storage interface methods return Promises)
    const result = await (method as Function).apply(backend, req.args);
    
    // Send back success
    parentPort!.postMessage({ id: req.id, result } as IpcResponse);
  } catch (err: any) {
    // Send back error
    parentPort!.postMessage({
      id: req.id,
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack,
      },
    } as IpcResponse);
  }
});
