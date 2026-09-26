import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the MCP server entrypoint for stdio integration tests. */
export const SERVER_ENTRY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "index.js",
);
