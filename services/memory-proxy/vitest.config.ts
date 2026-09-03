import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.ts", "packages/**/src/__tests__/**/*.test.ts", "packages/**/src/**/__tests__/**/*.test.ts"],
  },
});
