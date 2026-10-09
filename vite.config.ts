import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // The app loads this address during `mygo dev` (devUrl in mygo.config.ts).
    // 绑定 IPv4 回环：5173 的 IPv4 通配地址常被其它开发服务器占用。
    host: "127.0.0.1",
    port: 5273,
    strictPort: true,
    // The development app and the packaged builds are not the page's.
    watch: { ignored: ["**/.mygo/**", "**/build/**"] },
  },
});
