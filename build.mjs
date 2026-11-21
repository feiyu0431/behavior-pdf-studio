import { cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("src/index.html", "dist/index.html");
await cp("src/styles.css", "dist/styles.css");
const esbuild = resolve("node_modules/.bin/esbuild.cmd");
const result = spawnSync(
  esbuild,
  ["src/app.js", "--bundle", "--minify", "--format=iife", "--target=es2020", "--outfile=dist/app.js"],
  { stdio: "inherit", shell: true },
);
if (result.status !== 0) process.exit(result.status ?? 1);
