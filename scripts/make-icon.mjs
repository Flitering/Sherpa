// Рисует иконку приложения из SVG и собирает .ico (16…256) и .png.
// Запуск: npx electron scripts/make-icon.mjs
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "electron", "assets");

// гора с флагом на вершине: «проводник» в цветах интерфейса
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#26271f"/><stop offset="1" stop-color="#0d0e0b"/></linearGradient></defs>
  <rect x="10" y="10" width="236" height="236" rx="46" fill="url(#bg)" stroke="#b8aa7f" stroke-width="12"/>
  <polygon points="34,204 114,78 150,134 172,106 222,204" fill="#d9d4bf"/>
  <polygon points="114,78 136,113 122,106 112,118 99,102" fill="#e3c96b"/>
  <polygon points="172,106 186,128 176,124 167,132 160,124" fill="#e3c96b"/>
  <rect x="110" y="40" width="8" height="42" fill="#d9d4bf"/>
  <polygon points="118,40 156,50 118,62" fill="#c4553f"/>
</svg>`;

const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

app.whenReady().then(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    // SVG рисуется в canvas нужного размера прямо в странице
    const w = new BrowserWindow({ width: 300, height: 300, show: false });
    await w.loadURL("about:blank");
    const urls = await w.webContents.executeJavaScript(`(async () => {
        const img = new Image();
        img.src = "data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}";
        await img.decode();
        return ${JSON.stringify(SIZES)}.map((s) => {
            const c = document.createElement("canvas");
            c.width = c.height = s;
            const g = c.getContext("2d");
            g.imageSmoothingQuality = "high";
            g.drawImage(img, 0, 0, s, s);
            return c.toDataURL("image/png");
        });
    })()`);
    w.destroy();
    const pngs = urls.map((u) => Buffer.from(u.split(",")[1], "base64"));
    // ICO с PNG внутри (Windows Vista+)
    const header = Buffer.alloc(6 + 16 * pngs.length);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(pngs.length, 4);
    let offset = header.length;
    pngs.forEach((p, i) => {
        const s = SIZES[i];
        const e = 6 + 16 * i;
        header.writeUInt8(s >= 256 ? 0 : s, e);
        header.writeUInt8(s >= 256 ? 0 : s, e + 1);
        header.writeUInt8(0, e + 2);
        header.writeUInt8(0, e + 3);
        header.writeUInt16LE(1, e + 4);
        header.writeUInt16LE(32, e + 6);
        header.writeUInt32LE(p.length, e + 8);
        header.writeUInt32LE(offset, e + 12);
        offset += p.length;
    });
    fs.writeFileSync(path.join(OUT, "icon.ico"), Buffer.concat([header, ...pngs]));
    fs.writeFileSync(path.join(OUT, "icon.png"), pngs[SIZES.indexOf(256)]);
    fs.writeFileSync(path.join(OUT, "icon.svg"), SVG);
    console.log("icons →", OUT);
    app.quit();
});
