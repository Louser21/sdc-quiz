import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load the repo-root `.env` regardless of the cwd the process started in.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
loadDotenv({ path: resolve(repoRoot, ".env") });