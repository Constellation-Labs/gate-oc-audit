import { defineConfig } from "vite";

export default defineConfig({
  root: "src/control-ui",
  base: "/plugins/audit/",
  build: {
    outDir: "../../dist/control-ui",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
    target: "es2022",
  },
  esbuild: {
    target: "es2022",
  },
});
