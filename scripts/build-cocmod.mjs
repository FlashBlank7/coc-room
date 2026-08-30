// Assemble importable .cocmod packages from parsed module JSON plus art/audio
// assets, then verify each package round-trips through the app's own parser.
//
// Usage:  node scripts/build-cocmod.mjs
//
// Assets live in local-modules/素材 and are matched to a module by filename
// prefix (see PACKAGES below). Accepted formats mirror the .cocmod contract:
// static WebP images (≤8 MiB) and mp3/ogg/opus/wav audio (≤64 MiB). PNG art
// must be converted first, e.g. with Pillow:
//   python -c "from PIL import Image; Image.open('a.png').save('a.webp', quality=90, method=6)"
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const localModules = join(repoRoot, "local-modules");
const assetDir = join(localModules, "素材");

const PACKAGES = [
  {
    moduleJson: "观止-见世之蝶-codex重解析.cocmod.json",
    prefix: "观止-",
    output: "观止-见世之蝶.cocmod",
  },
  {
    moduleJson: "寒月-通往天国的终幕曲.cocmod.json",
    prefix: "寒月-",
    output: "寒月-通往天国的终幕曲.cocmod",
  },
];

const MEDIA_TYPES = new Map([
  ["webp", "image/webp"],
  ["mp3", "audio/mpeg"],
  ["ogg", "audio/ogg"],
  ["opus", "audio/ogg"],
  ["wav", "audio/wav"],
]);

function findEsbuild() {
  const store = join(repoRoot, "node_modules", ".pnpm");
  const entries = readdirSync(store)
    .filter((name) => /^esbuild@\d/.test(name))
    .sort();
  const chosen = entries.at(-1);
  if (!chosen) throw new Error("esbuild not found in node_modules/.pnpm; run pnpm install");
  return createRequire(import.meta.url)(join(store, chosen, "node_modules", "esbuild"));
}

async function loadCocmodApi() {
  const esbuild = findEsbuild();
  const outfile = join(mkdtempSync(join(tmpdir(), "cocmod-build-")), "cocmod-bundle.cjs");
  await esbuild.build({
    entryPoints: [join(repoRoot, "apps", "desktop", "src", "lib", "cocmod-package.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  return createRequire(import.meta.url)(outfile);
}

function webpDimensions(bytes) {
  const tag = bytes.toString("ascii", 12, 16);
  if (tag === "VP8X") {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }
  if (tag === "VP8 ") {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (tag === "VP8L") {
    const packed = bytes.readUInt32LE(21);
    return { width: 1 + (packed & 0x3fff), height: 1 + ((packed >> 14) & 0x3fff) };
  }
  throw new Error("unrecognized WebP header");
}

function collectAssets(prefix) {
  const assets = [];
  for (const file of readdirSync(assetDir).sort()) {
    if (!file.startsWith(prefix)) continue;
    const extension = file.split(".").pop()?.toLowerCase() ?? "";
    if (extension === "png") {
      console.log(`  (跳过 ${file}：请先转换为 WebP 再打包)`);
      continue;
    }
    const mediaType = MEDIA_TYPES.get(extension);
    if (mediaType === undefined) continue;
    const bytes = readFileSync(join(assetDir, file));
    const descriptor = {
      schemaVersion: 1,
      assetId: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      mediaType,
      byteLength: bytes.byteLength,
      ...(mediaType === "image/webp" ? webpDimensions(bytes) : {}),
      bytes: new Uint8Array(bytes),
      extension: extension === "opus" ? "opus" : extension,
    };
    assets.push(descriptor);
    console.log(`  + ${file} (${(bytes.byteLength / 1024).toFixed(0)} KiB, ${mediaType})`);
  }
  return assets;
}

const { createCocmodPackage, parseCocmodPackage } = await loadCocmodApi();
for (const { moduleJson, prefix, output } of PACKAGES) {
  console.log(`打包 ${output}:`);
  const modulePackage = JSON.parse(readFileSync(join(localModules, moduleJson), "utf8"));
  const assets = collectAssets(prefix);
  const bytes = await createCocmodPackage(modulePackage, { assets });
  const outPath = join(localModules, output);
  writeFileSync(outPath, bytes);
  const roundTrip = await parseCocmodPackage(new Uint8Array(readFileSync(outPath)));
  if (roundTrip.module.moduleId !== modulePackage.moduleId || roundTrip.assets.length !== assets.length) {
    throw new Error(`${output} failed round-trip verification`);
  }
  console.log(`OK ${output}: ${(bytes.byteLength / 1024).toFixed(0)} KiB, 模组=${roundTrip.module.metadata.title}, 资源=${roundTrip.assets.length} (再导入校验通过)`);
}
