#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const shebang = "#!/usr/bin/env node\n";

// MCP entry point
const entry = path.join(__dirname, "..", "dist", "mcp", "index.js");
if (fs.existsSync(entry)) {
  const src = fs.readFileSync(entry, "utf8");
  if (!src.startsWith("#!")) {
    fs.writeFileSync(entry, shebang + src);
  }
  fs.chmodSync(entry, 0o755);
}

// Codebase indexer
const indexer = path.join(__dirname, "..", "dist", "scripts", "index-codebase.js");
if (fs.existsSync(indexer)) {
  const src = fs.readFileSync(indexer, "utf8");
  if (!src.startsWith("#!")) {
    fs.writeFileSync(indexer, shebang + src);
  }
  fs.chmodSync(indexer, 0o755);
}
