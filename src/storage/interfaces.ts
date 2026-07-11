import { access, mkdir, readFile, writeFile } from "fs/promises";
import { dirname, resolve, sep } from "path";

export type StorageData = string | Buffer | Uint8Array;

export interface StorageAdapter {
  read(key: string): Promise<Buffer | null>;
  write(key: string, data: StorageData): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export interface LocalStorageAdapterOptions {
  rootDir: string;
}

export class LocalStorageAdapter implements StorageAdapter {
  private readonly rootDir: string;

  constructor(rootDirOrOptions: string | LocalStorageAdapterOptions) {
    this.rootDir = resolve(
      typeof rootDirOrOptions === "string"
        ? rootDirOrOptions
        : rootDirOrOptions.rootDir
    );
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  async write(key: string, data: StorageData): Promise<void> {
    const filePath = this.pathFor(key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.pathFor(key));
      return true;
    } catch (err: any) {
      if (err?.code === "ENOENT") return false;
      throw err;
    }
  }

  private pathFor(key: string): string {
    const normalized = normalizeStorageKey(key);
    const fullPath = resolve(this.rootDir, normalized.split("/").join(sep));
    const rootWithSep = this.rootDir.endsWith(sep) ? this.rootDir : `${this.rootDir}${sep}`;
    if (fullPath !== this.rootDir && !fullPath.startsWith(rootWithSep)) {
      throw new Error(`Storage key escapes root: ${key}`);
    }
    return fullPath;
  }
}

export interface S3StorageAdapterOptions {
  bucket: string;
  region?: string;
  prefix?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

export class S3StorageAdapter implements StorageAdapter {
  private readonly options: S3StorageAdapterOptions;
  private s3?: any;

  constructor(options: S3StorageAdapterOptions) {
    if (!options.bucket) {
      throw new Error("S3StorageAdapter requires a bucket");
    }
    this.options = {
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
      ...options,
    };
  }

  async read(key: string): Promise<Buffer | null> {
    const s3 = await this.getS3();
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    try {
      const response = await s3.send(new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: this.s3Key(key),
      }));
      return bodyToBuffer(response.Body);
    } catch (err: any) {
      if (isMissingObject(err)) return null;
      throw err;
    }
  }

  async write(key: string, data: StorageData): Promise<void> {
    const s3 = await this.getS3();
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await s3.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: this.s3Key(key),
      Body: data,
    }));
  }

  async exists(key: string): Promise<boolean> {
    const s3 = await this.getS3();
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    try {
      await s3.send(new HeadObjectCommand({
        Bucket: this.options.bucket,
        Key: this.s3Key(key),
      }));
      return true;
    } catch (err: any) {
      if (isMissingObject(err)) return false;
      throw err;
    }
  }

  private async getS3() {
    if (this.s3) return this.s3;
    const { S3Client } = await import("@aws-sdk/client-s3");
    this.s3 = new S3Client({
      region: this.options.region,
      endpoint: this.options.endpoint,
      credentials: this.options.accessKeyId && this.options.secretAccessKey
        ? {
            accessKeyId: this.options.accessKeyId,
            secretAccessKey: this.options.secretAccessKey,
          }
        : undefined,
      forcePathStyle: this.options.forcePathStyle ?? !!this.options.endpoint,
    });
    return this.s3;
  }

  private s3Key(key: string): string {
    const normalized = normalizeStorageKey(key);
    const prefix = normalizeStoragePrefix(this.options.prefix);
    return `${prefix}${normalized}`;
  }
}

export function createStorageAdapterFromEnv(opts: {
  localRoot?: string;
  s3Prefix?: string;
} = {}): StorageAdapter {
  if (process.env.STORAGE_BACKEND === "s3") {
    const bucket =
      process.env.STORAGE_S3_BUCKET ??
      process.env.S3_BUCKET ??
      process.env.AWS_S3_BUCKET;
    if (!bucket) {
      throw new Error(
        "STORAGE_BACKEND=s3 requires STORAGE_S3_BUCKET, S3_BUCKET, or AWS_S3_BUCKET"
      );
    }
    return new S3StorageAdapter({
      bucket,
      region: process.env.STORAGE_S3_REGION ?? process.env.AWS_REGION,
      endpoint: process.env.STORAGE_S3_ENDPOINT ?? process.env.S3_ENDPOINT,
      prefix: process.env.STORAGE_PREFIX ?? opts.s3Prefix,
      accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY,
    });
  }

  return new LocalStorageAdapter(opts.localRoot ?? process.env.STORAGE_LOCAL_ROOT ?? ".");
}

function normalizeStorageKey(key: string): string {
  const normalized = key.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return parts.join("/");
}

function normalizeStoragePrefix(prefix?: string): string {
  if (!prefix) return "";
  return `${prefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")}/`;
}

function isMissingObject(err: any): boolean {
  const status = err?.$metadata?.httpStatusCode;
  return err?.name === "NoSuchKey" ||
    err?.name === "NotFound" ||
    err?.Code === "NoSuchKey" ||
    err?.code === "NoSuchKey" ||
    status === 404;
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  if (typeof (body as any).transformToByteArray === "function") {
    return Buffer.from(await (body as any).transformToByteArray());
  }
  if (typeof (body as any).pipe === "function") {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolvePromise, reject) => {
      (body as NodeJS.ReadableStream)
        .on("data", (chunk) => chunks.push(Buffer.from(chunk)))
        .on("error", reject)
        .on("end", resolvePromise);
    });
    return Buffer.concat(chunks);
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
