import { defineConfig, mergeConfig } from "vite";

import baseConfig from "./vite.config.ts";

export default defineConfig(async (env) => {
  const config = await baseConfig(env);
  return mergeConfig(config, {
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: "http://localhost:3001",
          changeOrigin: true,
        },
      },
    },
  });
});
