import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("AgentMailboxDesktop", {
  getConfig: () => ipcRenderer.invoke("agentmailbox:get-config"),
  onServerExit: (callback: (event: { code: number | null; signal: string | null }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { code: number | null; signal: string | null }) => callback(payload);
    ipcRenderer.on("agentmailbox:server-exit", listener);
    return () => ipcRenderer.removeListener("agentmailbox:server-exit", listener);
  },
});
