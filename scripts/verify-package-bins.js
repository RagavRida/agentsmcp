#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const packagePath = path.join(__dirname, "..", "package.json");
const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const bins = manifest.bin ?? {};

if (typeof bins !== "object" || Array.isArray(bins) || Object.keys(bins).length === 0) {
  throw new Error("package.json must declare at least one executable in bin");
}

for (const [name, relativePath] of Object.entries(bins)) {
  if (typeof relativePath !== "string") {
    throw new Error(`Binary ${name} must have a string path`);
  }

  const filePath = path.join(__dirname, "..", relativePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Binary ${name} is missing from the publish payload: ${relativePath}`);
  }

  const source = fs.readFileSync(filePath, "utf8");
  if (!source.startsWith("#!/usr/bin/env node")) {
    throw new Error(`Binary ${name} must start with a Node shebang: ${relativePath}`);
  }
}

console.log(`Verified ${Object.keys(bins).length} publishable CLI binaries for agentsmcp@${manifest.version}.`);
