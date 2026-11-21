import { defineConfig } from "vitest/config";

// Shared test config for the whole monorepo. Each package is a Vitest project
// with its own small vitest.config.mts.
export default defineConfig({
  test: {
    projects: ["packages/*"],
  },
});
