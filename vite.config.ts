import { defineConfig } from "vite";
export default defineConfig({
  define: {
    __ASSET_VERSION__: JSON.stringify(process.env.SOURCE_COMMIT ?? "dev"),
  },
  server: {
    port: 5190,
    proxy: {
      "/api": "http://127.0.0.1:3190",
      "/ws": { target: "ws://127.0.0.1:3190", ws: true },
    },
  },
  build: { target: "es2022" },
});
