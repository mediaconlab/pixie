import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
const production = !watch;

mkdirSync("dist/media", { recursive: true });
copyFileSync("media/pixie.svg", "dist/media/pixie.svg");

/** @type {import('esbuild').BuildOptions[]} */
const configs = [
  {
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    external: ["vscode", "bufferutil", "utf-8-validate"],
    sourcemap: !production,
    minify: production,
    logLevel: "info",
  },
  {
    entryPoints: ["src/webview/main.ts"],
    outfile: "dist/webview.js",
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    sourcemap: !production,
    minify: production,
    logLevel: "info",
  },
  {
    entryPoints: ["src/webview/panel.css"],
    outfile: "dist/panel.css",
    bundle: true,
    minify: production,
    logLevel: "info",
  },
];

if (watch) {
  for (const c of configs) {
    const ctx = await esbuild.context(c);
    await ctx.watch();
  }
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
