function isProduction(): boolean {
  return (process.env.NODE_ENV ?? "").toLowerCase() === "production";
}

function truthy(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name] ?? "");
}

/**
 * Fail closed for the standalone production server. Library consumers and
 * local development remain zero-config; production deployments must opt into
 * durable storage and an authentication boundary explicitly.
 */
export function validateProductionConfig(): void {
  if (!isProduction()) return;

  const database = process.env.AGENTSMCP_DB ?? process.env.AGENTMAILBOX_DB ?? "";
  if (!/^postgres(?:ql)?:\/\//i.test(database)) {
    throw new Error("Production requires AGENTSMCP_DB to be a PostgreSQL URL");
  }

  const cloudMode = truthy("CLOUD_MODE") || truthy("AGENTSMCP_CLOUD_MODE");
  const apiKey = process.env.AGENTSMCP_API_KEY ?? process.env.AGENTMAILBOX_API_KEY;
  if (!cloudMode && !apiKey) {
    throw new Error("Production requires AGENTSMCP_API_KEY or CLOUD_MODE=true");
  }
  if (cloudMode && !process.env.JWT_SECRET) {
    throw new Error("CLOUD_MODE production requires JWT_SECRET");
  }
}
