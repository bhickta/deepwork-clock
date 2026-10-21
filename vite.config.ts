import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The application version is injected from package.json so the About view can
// never drift from the released version (scripts/verify-versions.mjs checks
// the fallback literal in src/version.ts as well).
const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

// Tauri drives this dev server; see src-tauri/tauri.conf.json (devUrl / beforeDevCommand).
// The port and host are fixed so the native shell and the browser preview always agree.
export default defineConfig({
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      // Rust sources are rebuilt by cargo, not by the frontend dev server.
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // Release assets stay small and free of source paths; debugging uses the dev server.
    sourcemap: false,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 150,
  },
});
