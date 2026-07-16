import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GitConnectorRequest, SftpConnectorRequest } from "../api/dto";
import type { IngestionRequest, SourceArtifact, TenantScope } from "./contracts";

const execFileAsync = promisify(execFile);

export const DEFAULT_CONNECTOR_MAX_FILES = 500;
export const DEFAULT_CONNECTOR_MAX_FILE_BYTES = 2_000_000;

const SOURCE_EXTENSIONS = new Set([
  ".cbl",
  ".cob",
  ".cobol",
  ".cpy",
  ".copy",
  ".jcl",
  ".job",
  ".pli",
  ".pl1",
  ".rexx",
  ".rex",
  ".sql",
  ".txt",
]);

const IGNORED_PATH_SEGMENTS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
  "coverage",
]);

export interface DirectoryConnectorOptions extends TenantScope {
  dataset: string;
  connectorRunId?: string;
  maxFiles?: number;
  maxFileBytes?: number;
}

export interface ConnectorArtifacts {
  dataset: string;
  connectorRunId?: string;
  connector?: string;
  files: SourceArtifact[];
}

export async function collectSourceArtifactsFromDirectory(
  rootDirectory: string,
  options: DirectoryConnectorOptions,
): Promise<ConnectorArtifacts> {
  const root = path.resolve(rootDirectory);
  const files: SourceArtifact[] = [];
  const maxFiles = normalizeMaxFiles(options.maxFiles);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_CONNECTOR_MAX_FILE_BYTES;

  async function visit(current: string): Promise<void> {
    if (files.length >= maxFiles) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const absolutePath = path.join(current, entry.name);
      const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
      if (!relativePath || shouldIgnorePath(relativePath)) continue;

      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }

      if (!entry.isFile() || !isImportableSourcePath(relativePath)) continue;
      const metadata = await stat(absolutePath);
      if (metadata.size > maxFileBytes) continue;
      const code = await readFile(absolutePath, "utf8");
      files.push(sourceArtifactFor(relativePath, code, options));
    }
  }

  await visit(root);
  return { dataset: options.dataset, connectorRunId: options.connectorRunId, files };
}

export async function cloneGitRepository(
  request: GitConnectorRequest & TenantScope,
): Promise<ConnectorArtifacts> {
  assertAllowedGitUrl(request.repoUrl);
  const tempRoot = await mkdtemp(path.join(tmpdir(), "agentmailbox-git-"));
  const checkoutDirectory = path.join(tempRoot, "repo");
  const args = ["clone", "--depth", "1"];
  if (request.branch) args.push("--branch", request.branch);
  args.push(request.repoUrl, checkoutDirectory);

  try {
    await execFileAsync("git", args, {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
      },
    });
    const artifacts = await collectSourceArtifactsFromDirectory(checkoutDirectory, {
      dataset: request.dataset,
      tenantId: request.tenantId,
      connectorRunId: request.connectorRunId ?? `git-${Date.now()}`,
      maxFiles: request.maxFiles,
    });
    return { ...artifacts, connector: "git" };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function readSftpRepository(
  request: SftpConnectorRequest & TenantScope,
): Promise<ConnectorArtifacts> {
  const mod = await import("ssh2-sftp-client");
  const SftpClient = mod.default as new () => {
    connect(config: Record<string, unknown>): Promise<void>;
    list(remotePath: string): Promise<Array<{ name: string; type: string; size?: number }>>;
    get(remotePath: string): Promise<Buffer | string>;
    end(): Promise<void>;
  };
  const client = new SftpClient();
  const files: SourceArtifact[] = [];
  const maxFiles = normalizeMaxFiles(request.maxFiles);

  await client.connect({
    host: request.host,
    port: request.port ?? 22,
    username: request.username,
    password: request.password,
    privateKey: request.privateKey,
    passphrase: request.passphrase,
  });

  async function visit(remoteDirectory: string): Promise<void> {
    if (files.length >= maxFiles) return;
    const entries = await client.list(remoteDirectory);
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const remotePath = posixJoin(remoteDirectory, entry.name);
      const relativePath = normalizeRelativePath(path.posix.relative(request.remotePath, remotePath));
      if (!relativePath || shouldIgnorePath(relativePath)) continue;
      if (entry.type === "d") {
        await visit(remotePath);
        continue;
      }
      if (entry.type !== "-" || !isImportableSourcePath(relativePath)) continue;
      if ((entry.size ?? 0) > DEFAULT_CONNECTOR_MAX_FILE_BYTES) continue;
      const raw = await client.get(remotePath);
      const code = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      files.push(sourceArtifactFor(relativePath, code, request));
    }
  }

  try {
    await visit(request.remotePath);
  } finally {
    await client.end();
  }

  return { dataset: request.dataset, connectorRunId: request.connectorRunId ?? `sftp-${Date.now()}`, connector: "sftp", files };
}

export function connectorArtifactsToIngestionRequest(
  artifacts: ConnectorArtifacts,
  scope: TenantScope = {},
): IngestionRequest {
  return {
    dataset: artifacts.dataset,
    connectorRunId: artifacts.connectorRunId,
    connector: artifacts.connector,
    tenantId: scope.tenantId,
    files: artifacts.files.map((file) => ({
      ...file,
      tenantId: scope.tenantId ?? file.tenantId,
      dataset: artifacts.dataset,
    })),
  };
}

export function isImportableSourcePath(sourcePath: string): boolean {
  const normalized = normalizeRelativePath(sourcePath);
  if (!normalized || shouldIgnorePath(normalized)) return false;
  return SOURCE_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

function sourceArtifactFor(relativePath: string, code: string, options: DirectoryConnectorOptions): SourceArtifact {
  const normalized = normalizeRelativePath(relativePath);
  return {
    sourceId: `${options.dataset}/${normalized}`,
    filename: normalized,
    code,
    tenantId: options.tenantId,
    dataset: options.dataset,
    language: "auto",
  };
}

function normalizeMaxFiles(value?: number): number {
  if (!value) return DEFAULT_CONNECTOR_MAX_FILES;
  return Math.min(Math.max(1, value), DEFAULT_CONNECTOR_MAX_FILES);
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\/+/, "");
}

function shouldIgnorePath(sourcePath: string): boolean {
  return sourcePath.split("/").some((segment) => IGNORED_PATH_SEGMENTS.has(segment));
}

function posixJoin(base: string, name: string): string {
  return `${base.replace(/\/+$/, "")}/${name.replace(/^\/+/, "")}`;
}

function assertAllowedGitUrl(repoUrl: string): void {
  if (/^https?:\/\//i.test(repoUrl) || /^ssh:\/\//i.test(repoUrl) || /^git@[^:]+:.+/i.test(repoUrl)) {
    return;
  }
  if (process.env.NODE_ENV === "test" && /^file:\/\//i.test(repoUrl)) {
    return;
  }
  throw new Error("Unsupported Git repository URL. Use HTTPS, SSH, or a configured test file URL.");
}
