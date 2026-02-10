import { build } from "esbuild";

await build({
  entryPoints: ["dist/index.js"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "dist/bundle.cjs",
  banner: { js: "#!/usr/bin/env node" },
  minify: true,
});
