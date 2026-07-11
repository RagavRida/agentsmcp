// ============================================================
// BYOS — Bring Your Own Storage
//
// The bank hosts their own data. Our system is stateless compute.
// Vectors, KV cache tensors, and audit trails are stored in the
// bank's S3 bucket. We never persist proprietary code.
//
// Architecture:
//   Bank's S3 ← vectors, KV cache, .agent_history
//   Our Modal ← stateless GPU compute (reads → processes → forgets)
// ============================================================

export interface BYOSConfig {
  /** S3-compatible endpoint (AWS, MinIO, Backblaze) */
  endpoint?: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Prefix for all keys (e.g., 'legacy-analysis/') */
  prefix?: string;
}

export interface BYOSClient {
  /** Store vector embeddings for a program */
  storeVectors(programName: string, data: Buffer): Promise<string>;
  /** Load vector embeddings for a program */
  loadVectors(programName: string): Promise<Buffer | null>;
  /** Store pre-computed KV cache tensors */
  storeKVCache(programName: string, tensors: Buffer): Promise<string>;
  /** Load KV cache tensors for injection into vLLM */
  loadKVCache(programName: string): Promise<Buffer | null>;
  /** Store audit trail (.agent_history) */
  storeAuditTrail(sessionId: string, entries: string): Promise<string>;
  /** Generate a pre-signed URL (for zero-trust access) */
  presignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
  /** List all stored programs */
  listPrograms(): Promise<string[]>;
}

/**
 * S3-backed BYOS implementation using the AWS SDK.
 * Works with any S3-compatible storage (AWS, MinIO, Backblaze B2).
 */
export class S3BYOSClient implements BYOSClient {
  private config: BYOSConfig;
  private s3: any; // Lazy-loaded AWS S3 client

  constructor(config: BYOSConfig) {
    this.config = config;
  }

  private async getS3() {
    if (this.s3) return this.s3;
    // Lazy-load AWS SDK to avoid mandatory dependency
    const { S3Client } = await import("@aws-sdk/client-s3");
    this.s3 = new S3Client({
      region: this.config.region,
      endpoint: this.config.endpoint,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
      forcePathStyle: !!this.config.endpoint, // MinIO compatibility
    });
    return this.s3;
  }

  private key(parts: string[]): string {
    const prefix = this.config.prefix || "";
    return `${prefix}${parts.join("/")}`;
  }

  async storeVectors(programName: string, data: Buffer): Promise<string> {
    const key = this.key(["vectors", `${programName}.bin`]);
    const s3 = await this.getS3();
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await s3.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      Body: data,
      ContentType: "application/octet-stream",
      Metadata: {
        program: programName,
        type: "vector-embeddings",
        timestamp: new Date().toISOString(),
      },
    }));
    return `s3://${this.config.bucket}/${key}`;
  }

  async loadVectors(programName: string): Promise<Buffer | null> {
    const key = this.key(["vectors", `${programName}.bin`]);
    return this.getObject(key);
  }

  async storeKVCache(programName: string, tensors: Buffer): Promise<string> {
    const key = this.key(["kv-cache", `${programName}.pt`]);
    const s3 = await this.getS3();
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await s3.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      Body: tensors,
      ContentType: "application/octet-stream",
      Metadata: {
        program: programName,
        type: "kv-cache-tensors",
        timestamp: new Date().toISOString(),
      },
    }));
    return `s3://${this.config.bucket}/${key}`;
  }

  async loadKVCache(programName: string): Promise<Buffer | null> {
    const key = this.key(["kv-cache", `${programName}.pt`]);
    return this.getObject(key);
  }

  async storeAuditTrail(sessionId: string, entries: string): Promise<string> {
    const key = this.key(["audit", `${sessionId}.agent_history.jsonl`]);
    const s3 = await this.getS3();
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await s3.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      Body: Buffer.from(entries, "utf-8"),
      ContentType: "application/jsonl",
      Metadata: {
        sessionId,
        type: "audit-trail",
        timestamp: new Date().toISOString(),
      },
    }));
    return `s3://${this.config.bucket}/${key}`;
  }

  async presignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const s3 = await this.getS3();
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: this.key([key]),
    });
    return getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
  }

  async listPrograms(): Promise<string[]> {
    const s3 = await this.getS3();
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: this.config.bucket,
      Prefix: this.key(["vectors/"]),
    }));

    const programs: string[] = [];
    for (const obj of result.Contents || []) {
      const match = obj.Key?.match(/vectors\/(.+)\.bin$/);
      if (match) programs.push(match[1]);
    }
    return programs;
  }

  // ── Helpers ────────────────────────────────────────────────

  private async getObject(key: string): Promise<Buffer | null> {
    try {
      const s3 = await this.getS3();
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const response = await s3.send(new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }));
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (err: any) {
      if (err.name === "NoSuchKey" || err.Code === "NoSuchKey") return null;
      throw err;
    }
  }
}
