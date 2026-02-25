import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { minify } from "terser";
import postcss from "postcss";
import cssnano from "cssnano";
import fg from "fast-glob";

const require = createRequire(import.meta.url);
const { PurgeCSS } = require("purgecss");
const purgeConfig = require("../purgecss.config.cjs");

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(thisFile), "..");
const distDir = path.join(repoRoot, "dist-assets");
const assetListPath = path.join(repoRoot, "asset-list.json");
const checkOnly = process.argv.includes("--check");

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function normalizeAssetPath(assetPath) {
  return assetPath.replace(/^\.\//, "");
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".css")) return "css";
  if (filePath.endsWith(".js")) return "js";
  return "other";
}

function hashContent(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 10);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readAssetList() {
  const raw = await fs.readFile(assetListPath, "utf8");
  const parsed = JSON.parse(raw);

  const styles = (parsed.styles || []).map((item) => ({
    type: "css",
    path: normalizeAssetPath(item.path),
    module: false
  }));
  const scripts = (parsed.scripts || []).map((item) => ({
    type: "js",
    path: normalizeAssetPath(item.path),
    module: Boolean(item.module)
  }));
  return [...styles, ...scripts];
}

async function loadPurgeContent() {
  const patterns = Array.isArray(purgeConfig.content) ? purgeConfig.content : [];
  const filePaths = await fg(patterns, {
    cwd: repoRoot,
    onlyFiles: true,
    unique: true,
    ignore: ["dist-assets/**", "node_modules/**"]
  });

  const content = [];
  for (const relativePath of filePaths) {
    const absolutePath = path.join(repoRoot, relativePath);
    const raw = await fs.readFile(absolutePath, "utf8");
    content.push({ raw, extension: path.extname(relativePath).slice(1) || "html" });
  }
  return content;
}

async function optimizeCss(relativePath, rawCss, purgeContent) {
  const purge = new PurgeCSS();
  const purgeResults = await purge.purge({
    content: purgeContent,
    css: [{ raw: rawCss }],
    safelist: purgeConfig.safelist || {}
  });

  const purgedCss = purgeResults[0]?.css ?? rawCss;
  const minified = await postcss([cssnano({ preset: "default" })]).process(purgedCss, {
    from: relativePath,
    map: false
  });

  return minified.css;
}

async function optimizeJs(relativePath, rawJs) {
  const result = await minify(rawJs, {
    compress: true,
    mangle: true,
    format: { comments: false }
  });

  if (!result.code) {
    throw new Error(`Terser did not return output for ${relativePath}`);
  }
  return result.code;
}

async function build() {
  const assets = await readAssetList();
  const purgeContent = await loadPurgeContent();

  await fs.rm(distDir, { recursive: true, force: true });

  const manifest = {};
  const assetsMeta = [];

  for (const asset of assets) {
    const relativePath = asset.path;
    const absolutePath = path.join(repoRoot, relativePath);
    if (!(await pathExists(absolutePath))) {
      continue;
    }

    const rawContent = await fs.readFile(absolutePath, "utf8");
    const kind = contentTypeFor(relativePath);
    let optimized = rawContent;

    if (kind === "js") {
      optimized = await optimizeJs(relativePath, rawContent);
    } else if (kind === "css") {
      optimized = await optimizeCss(relativePath, rawContent, purgeContent);
    }

    const parsed = path.parse(relativePath);
    const hash = hashContent(optimized);
    const outFile = `${parsed.name}.${hash}${parsed.ext}`;
    const outRelative = toPosix(path.join("dist-assets", parsed.dir, outFile));
    const outAbsolute = path.join(repoRoot, outRelative);
    await fs.mkdir(path.dirname(outAbsolute), { recursive: true });
    await fs.writeFile(outAbsolute, optimized, "utf8");

    manifest[relativePath] = outRelative;
    assetsMeta.push({ ...asset, localPath: relativePath, outputPath: outRelative });
  }

  const manifestJson = {
    generatedAt: new Date().toISOString(),
    assets: manifest
  };

  await fs.writeFile(path.join(distDir, "manifest.json"), `${JSON.stringify(manifestJson, null, 2)}\n`, "utf8");
  await fs.writeFile(
    path.join(distDir, "manifest.js"),
    `window.__JIGSAW_ASSET_MANIFEST__=${JSON.stringify(manifestJson)};\n`,
    "utf8"
  );
  await fs.writeFile(path.join(distDir, "asset-order.json"), `${JSON.stringify(assetsMeta, null, 2)}\n`, "utf8");
}

async function run() {
  await build();

  if (checkOnly) {
    const marker = path.join(distDir, "manifest.json");
    if (!(await pathExists(marker))) {
      throw new Error("Asset check failed: dist-assets/manifest.json not generated.");
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
