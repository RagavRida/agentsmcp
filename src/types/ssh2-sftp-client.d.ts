declare module "ssh2-sftp-client" {
  export default class SftpClient {
    connect(config: Record<string, unknown>): Promise<void>;
    list(remotePath: string): Promise<Array<{ name: string; type: string; size?: number }>>;
    get(remotePath: string): Promise<Buffer | string>;
    end(): Promise<void>;
  }
}
