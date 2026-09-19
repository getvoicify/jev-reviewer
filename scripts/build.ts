/**
 * Bundles the action entry point into the self-contained dist/index.js that
 * the GitHub Actions node20 runtime executes. Consumers never need Bun.
 */
const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  minify: true,
  sourcemap: "none",
});

if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  throw new Error("bun build failed");
}

for (const artifact of result.outputs) {
  console.log(`built ${artifact.path} (${artifact.size} bytes)`);
}
