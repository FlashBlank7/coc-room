// Generates the bundled preview image for every portrait style through the
// running dev AI bridge (pnpm dev must be up, Codex logged in):
//   node scripts/generate-portrait-style-previews.mjs [style-id ...]
// Every preview renders the same investigator so only the style differs.
// Output: apps/desktop/public/portrait-styles/<id>.webp (static WebP, ~360px).
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
const sharp = require(path.join(root, "..", "node_modules", ".pnpm", "sharp@0.35.2", "node_modules", "sharp"));

const BRIDGE_ORIGIN = process.env.COC_ROOM_WEB_ORIGIN ?? "http://127.0.0.1:1420";
const OUTPUT_DIR = path.join(root, "..", "apps", "desktop", "public", "portrait-styles");
const SUBJECT = "一位 1920 年代的调查员半身肖像：三十岁上下的东亚女性，短发，穿深色大衣与衬衫，神情沉静警觉，构图居中，单人，无文字。";

// Single source of truth shared with the app UI: id + researched concept-set
// prompt both come from portrait-styles.json.
const STYLES = JSON.parse(
  await (await import("node:fs/promises")).readFile(
    path.join(root, "..", "apps", "desktop", "src", "lib", "portrait-styles.json"),
    "utf8",
  ),
).map((style) => [style.id, style.stylePrompt]);
// The dev bridge caps concurrent AI tasks at 4; leave one slot free.
const MAX_PARALLEL = 3;

async function fetchSessionToken() {
  const response = await fetch(`${BRIDGE_ORIGIN}/`);
  if (!response.ok) throw new Error(`Vite page fetch failed: HTTP ${response.status}`);
  const html = await response.text();
  const match = html.match(/coc-room-local-ai-token" content="([^"]+)"/u);
  if (!match) throw new Error("页面里找不到 AI 桥令牌 —— dev 服务器开了吗？");
  return match[1];
}

async function generateOne(token, id, stylePrompt) {
  const body = {
    id: crypto.randomUUID(),
    kind: "character",
    description: SUBJECT,
    style: stylePrompt,
    aspectRatio: "portrait",
  };
  const response = await fetch(`${BRIDGE_ORIGIN}/__coc_room_local_ai/v1/image-generation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: BRIDGE_ORIGIN,
      "x-coc-room-local-ai": token,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const line = text.trim().split("\n").at(-1);
  const envelope = JSON.parse(line);
  if (envelope.type !== "result") {
    throw new Error(`${id}: ${envelope.error?.message ?? "generation failed"} (${envelope.error?.code ?? "?"})`);
  }
  const png = Buffer.from(envelope.result.dataBase64, "base64");
  const webp = await sharp(png)
    .resize({ width: 360, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  await writeFile(path.join(OUTPUT_DIR, `${id}.webp`), webp);
  return { id, pngBytes: png.length, webpBytes: webp.length };
}

const only = process.argv.slice(2);
const targets = only.length > 0 ? STYLES.filter(([id]) => only.includes(id)) : STYLES;
if (targets.length === 0) throw new Error(`unknown style ids: ${only.join(", ")}`);
await mkdir(OUTPUT_DIR, { recursive: true });
const token = await fetchSessionToken();
console.log(`generating ${targets.length} previews via ${BRIDGE_ORIGIN} ...`);
const queue = [...targets.entries()];
const results = new Array(targets.length);
await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, async () => {
  for (;;) {
    const next = queue.shift();
    if (!next) return;
    const [index, [id, prompt]] = next;
    results[index] = await generateOne(token, id, prompt)
      .then((value) => ({ status: "fulfilled", value }))
      .catch((reason) => ({ status: "rejected", reason }));
  }
}));
let failed = 0;
for (const [index, outcome] of results.entries()) {
  const id = targets[index][0];
  if (outcome.status === "fulfilled") {
    console.log(`ok  ${id}: png ${(outcome.value.pngBytes / 1024).toFixed(0)}KB -> webp ${(outcome.value.webpBytes / 1024).toFixed(0)}KB`);
  } else {
    failed += 1;
    console.error(`ERR ${id}: ${outcome.reason?.message ?? outcome.reason}`);
  }
}
if (failed > 0) {
  console.error(`${failed} preview(s) failed — rerun with just those ids to retry.`);
  process.exit(1);
}
