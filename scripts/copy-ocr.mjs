// Распознаватель текста (Tesseract) — внутри приложения, а не с CDN во время работы:
// так в приложение не попадает чужой код из сети, и распознавание работает без интернета.
// Копирует воркер, ядро (LSTM-сборки) и словари rus/eng в public/ocr (оттуда Vite кладёт их в dist).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NM = path.join(ROOT, "node_modules");
const OUT = path.join(ROOT, "public", "ocr");

const files = [
    [path.join(NM, "tesseract.js", "dist", "worker.min.js"), "worker.min.js"],
    ...["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"].map((f) => [path.join(NM, "tesseract.js-core", f), f]),
    ...["rus", "eng"].map((l) => [path.join(NM, "@tesseract.js-data", l, "4.0.0_best_int", `${l}.traineddata.gz`), path.join("lang", `${l}.traineddata.gz`)]),
];

for (const [src, rel] of files) {
    const dst = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const s = fs.statSync(src);
    if (fs.existsSync(dst) && fs.statSync(dst).size === s.size) continue;
    fs.copyFileSync(src, dst);
}
console.log("OCR →", OUT);
