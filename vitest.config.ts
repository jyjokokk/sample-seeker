import { defineConfig } from "vitest/config";

// Shared test config for the whole monorepo. Each package is a Vitest project
// with its own small vitest.config.mts (.mts because the packages are CommonJS).
export default defineConfig({
  test: {
    projects: ["packages/*"],
  },
});
