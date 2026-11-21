import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "desktop",
    environment: "node",
    include: ["src/**/*.test.ts"],
    // No desktop tests yet; keep `pnpm test` in this package green until there are.
    passWithNoTests: true,
  },
});
