import { defineConfig } from "vitest/config";

// Shared test config for the whole monorepo. Each package is a Vitest project
// with its own small vitest.config.ts.
// Tests run inside Electron's Node (see the "test" script in package.json),
// because better-sqlite3 is compiled for Electron's ABI.
export default defineConfig({
  test: {
    projects: ["packages/*"],
  },
});
