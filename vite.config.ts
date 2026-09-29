import { defineConfig } from "vite";
export default defineConfig({
  define: {
    __ASSET_VERSION__: JSON.stringify(process.env.SOURCE_COMMIT ?? "dev"),
  },
  server: {
    port: 5188,
    proxy: {
      "/api": "http://127.0.0.1:3188",
      "/ws": { target: "ws://127.0.0.1:3188", ws: true },
    },
  },
  build: { target: "es2022" },
});
