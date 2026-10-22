// Условия использования для страницы лицензии в установщике: TERMS.md → простой текст (UTF-8 с BOM).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const md = fs.readFileSync(path.join(ROOT, "TERMS.md"), "utf8");

const text = md
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => !/^\|[-|\s]+\|$/.test(l)) // разделитель таблицы
    .map((l) =>
        l
            .replace(/^#+\s*/, "")
            .replace(/\*\*(.+?)\*\*/g, "$1")
            .replace(/`([^`]+)`/g, "$1")
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => (t === u ? u : `${t} (${u})`))
            .replace(/^\|\s*(.*?)\s*\|$/, (_, row) => "  " + row.split(/\s*\|\s*/).join(" — ")),
    )
    .join("\r\n");

const out = path.join(ROOT, "electron", "assets", "license.txt");
fs.writeFileSync(out, "﻿" + text);
console.log("license →", out);
