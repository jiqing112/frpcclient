import { defineConfig } from "mygo-cli";

export default defineConfig({
  name: "frpcclient",
  identifier: "com.frpcclient.app",
  version: "1.0.0",
  // `mygo dev` runs devCommand and loads devUrl; `mygo build` runs
  // buildCommand and embeds frontendDist into the app.
  devUrl: "http://127.0.0.1:5273",
  devCommand: "npm run dev:web",
  buildCommand: "npm run build:web",
  frontendDist: "dist",
  bindings: "src/mygo.ts",
  out: "build",
});
