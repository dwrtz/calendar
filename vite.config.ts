import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false },
  server: { proxy: { "/api": "http://localhost:3000" } },
  test: { include: ["tests/**/*.test.ts"] },
} as any);
