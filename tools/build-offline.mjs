/* ============================================================
   オフライン版（ダブルクリックで開ける版）を作るスクリプト
   ------------------------------------------------------------
   使い方（リポジトリのフォルダで）:
     node tools/build-offline.mjs

   できるもの:
     offline/キャッフィーの琵琶湖サバイバル/      … このフォルダを丸ごとコピーすれば他のPCでも遊べる
     offline/キャッフィーの琵琶湖サバイバル.zip   … 上のフォルダをまとめたもの（配る用）

   しくみ:
     ダブルクリックで開いたページ（file://）では、Chrome が fetch・import()・
     type="module" の読み込みを禁止している。そこで
       - main.js は普通の <script> で読み込む
       - MediaPipe の本体と WASM の読み込み役は lib/ に置いて普通の <script> で読み込む
       - WASM 本体とモデルは文字データ（base64）にして lib/ の .js に入れる
     main.js は window.OFFLINE_MEDIAPIPE があるとき、ネットではなくこれを使う。

   ゲームを直したあとは、このスクリプトをもう一度実行すれば作り直せる。
   MediaPipe の部品は初回だけネットから取ってきて .offline-cache/ に残す。
   ============================================================ */

import { readFile, writeFile, mkdir, rm, cp, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "キャッフィーの琵琶湖サバイバル";
const OUT_BASE = path.join(ROOT, "offline");
const OUT = path.join(OUT_BASE, NAME);
const CACHE = path.join(ROOT, ".offline-cache");

/* main.js の CONFIG と同じ版を使う（ずれるとオンライン版と挙動が変わるため、main.js から読む） */
const mainSrc = await readFile(path.join(ROOT, "main.js"), "utf8");
const pick = (key) => {
  const m = mainSrc.match(new RegExp(key + ':\\s*"([^"]+)"'));
  if (!m) throw new Error(`main.js の CONFIG.${key} が見つかりません`);
  return m[1];
};
const VISION_URL = pick("VISION_URL");                 // .../vision_bundle.mjs
const WASM_URL = pick("WASM_URL");                     // .../wasm
const MODEL_URL = pick("MODEL_URL");
const PKG_URL = VISION_URL.replace(/\/[^/]+$/, "");    // .../tasks-vision@x.y.z

const PARTS = {
  "vision_bundle.cjs": `${PKG_URL}/vision_bundle.cjs`,
  "vision_wasm_internal.js": `${WASM_URL}/vision_wasm_internal.js`,
  "vision_wasm_internal.wasm": `${WASM_URL}/vision_wasm_internal.wasm`,
  "model.task": MODEL_URL,
};

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

/* 部品を取ってくる（キャッシュがあればそれを使う。URLが変わったら取り直す） */
async function getPart(name, url) {
  const dir = path.join(CACHE, encodeURIComponent(url).slice(-80));
  const file = path.join(dir, name);
  if (!(await exists(file))) {
    console.log(`ダウンロード中: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} を取得できませんでした (${res.status})`);
    await mkdir(dir, { recursive: true });
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  return readFile(file);
}

/* 置き換えに失敗したら止める（index.html を変えたときに気づけるように） */
function replaceOnce(src, pattern, replacement, label) {
  if (!pattern.test(src)) throw new Error(`index.html の「${label}」が見つかりません。build-offline.mjs を直してください。`);
  return src.replace(pattern, replacement);
}

const parts = {};
for (const [name, url] of Object.entries(PARTS)) parts[name] = await getPart(name, url);

await rm(OUT_BASE, { recursive: true, force: true });
await mkdir(path.join(OUT, "lib"), { recursive: true });

/* ゲーム本体（そのままコピー） */
for (const f of ["game.js", "sound.js", "style.css", "README.md"]) {
  await cp(path.join(ROOT, f), path.join(OUT, f));
}
await cp(path.join(ROOT, "assets"), path.join(OUT, "assets"), { recursive: true });

/* main.js: type="module" をやめて普通の <script> で読むので、変数が外に漏れないよう包む */
await writeFile(path.join(OUT, "main.js"), `(() => {\n"use strict";\n${mainSrc}\n})();\n`);

/* index.html */
let html = await readFile(path.join(ROOT, "index.html"), "utf8");
// Google Fonts はネットがないと読めないので外す（端末のフォントで表示される）
html = replaceOnce(html, /[ \t]*<link[^>]*fonts\.(googleapis|gstatic)\.com[^>]*>\r?\n/g, "", "Google Fonts の読み込み");
html = replaceOnce(
  html,
  /<script type="module" src="main\.js(?:\?[^"]*)?"><\/script>/,
  [
    '<!-- オフライン版: MediaPipe を同梱の lib/ から読み込む（tools/build-offline.mjs で生成） -->',
    '<script src="lib/vision_bundle.js"></script>',
    '<script src="lib/vision_wasm_internal.js"></script>',
    '<script src="lib/wasm-data.js"></script>',
    '<script src="lib/model-data.js"></script>',
    '<script src="main.js"></script>',
  ].join("\n"),
  "main.js の読み込み"
);
await writeFile(path.join(OUT, "index.html"), html);

/* lib/ */
const lib = (f) => path.join(OUT, "lib", f);
await writeFile(
  lib("vision_bundle.js"),
  "(function () {\nvar module = { exports: {} }; var exports = module.exports;\n" +
    parts["vision_bundle.cjs"].toString("utf8") +
    "\nwindow.OFFLINE_MEDIAPIPE = window.OFFLINE_MEDIAPIPE || {};\nwindow.OFFLINE_MEDIAPIPE.vision = module.exports;\n})();\n"
);
await writeFile(lib("vision_wasm_internal.js"), parts["vision_wasm_internal.js"]);
await writeFile(
  lib("wasm-data.js"),
  `window.OFFLINE_MEDIAPIPE = window.OFFLINE_MEDIAPIPE || {};\nwindow.OFFLINE_MEDIAPIPE.wasmBase64 = "${parts["vision_wasm_internal.wasm"].toString("base64")}";\n`
);
await writeFile(
  lib("model-data.js"),
  `window.OFFLINE_MEDIAPIPE = window.OFFLINE_MEDIAPIPE || {};\nwindow.OFFLINE_MEDIAPIPE.modelBase64 = "${parts["model.task"].toString("base64")}";\n`
);

/* 遊び方メモ */
await writeFile(
  path.join(OUT, "はじめにお読みください.txt"),
  [
    "キャッフィーの琵琶湖サバイバル（オフライン版）",
    "",
    "■ 遊び方",
    "  index.html をダブルクリックして開きます（Google Chrome か Microsoft Edge を使ってください）。",
    "  「カメラを使いますか？」と聞かれたら「許可」を押します。",
    "  インターネットにつながっていなくても遊べます。",
    "",
    "■ 他のパソコンで遊ぶとき",
    "  このフォルダを丸ごとコピーしてください。",
    "  index.html だけをコピーしても動きません（assets と lib のフォルダが必要です）。",
    "",
    "■ カメラがないとき",
    "  エラー画面の「キーボード（← →）で遊ぶ」を押すと、矢印キーで遊べます。",
    "",
    "■ 注意",
    "  記録（ランキング）はパソコンごと・ブラウザごとに別々に保存されます。",
    "  文字の見た目は、パソコンに入っているフォントによって少し変わります。",
    "",
  ].join("\r\n")
);

/* zip（Windows の PowerShell で作る。ほかの環境では飛ばす） */
const zip = path.join(OUT_BASE, `${NAME}.zip`);
try {
  execFileSync("powershell", [
    "-NoProfile", "-Command",
    `Compress-Archive -Path '${OUT}' -DestinationPath '${zip}' -Force`,
  ], { stdio: "inherit" });
  console.log(`zip: ${zip}`);
} catch {
  console.log("zip は作れませんでした（フォルダはできています）");
}

console.log(`できました: ${OUT}`);
