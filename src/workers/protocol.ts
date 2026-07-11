export interface IpcRequest {
  id: string;
  method: string;
  args: any[];
}

export interface IpcResponse {
  id: string;
  result?: any;
  error?: { name: string; message: string; stack?: string };
}
