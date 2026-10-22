// Какие выходы открыты в этом рейде — со скриншота игры.
//
// Двойное нажатие O в рейде показывает в правом верхнем углу таймер и список выходов, доступных именно тебе.
// Если в этот момент сделать скриншот, его картинка содержит этот список: здесь он распознаётся и сопоставляется
// с выходами карты (по русским и английским названиям). Читается только файл, который игра сама сохранила.

import type { GameMap } from "../types";
import { bestInLine, normalize, recognize } from "./ocr";

/** Названия выходов ЧВК (как в данных карты), найденные на скриншоте; null — списка выходов на скриншоте нет. */
export async function readExtractsFromShot(blob: Blob, map: GameMap): Promise<string[] | null> {
    const bmp = await createImageBitmap(blob);
    // список выходов — у правого края, в верхней половине экрана
    const w = Math.round(bmp.width * 0.42);
    const h = Math.round(bmp.height * 0.5);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")!.drawImage(bmp, bmp.width - w, 0, w, h, 0, 0, w, h);
    bmp.close();
    const text = await recognize(c);
    return matchExtracts(text, map);
}

/** Сопоставление распознанного текста с выходами карты. */
export function matchExtracts(text: string, map: GameMap): string[] | null {
    const lines = text.split(/\n+/).map(normalize).filter((l) => l.length >= 3);
    if (!lines.length) return null;
    const found = new Set<string>();
    for (const e of map.extracts) {
        if (e.faction === "scav") continue;
        for (const variant of [e.name, e.nameEn]) {
            if (!variant) continue;
            const name = normalize(variant);
            if (name.length < 3) continue;
            // выходы с номером (ЗБ-1011): буквы OCR путает с цифрами («35-1011»), номер читается надёжно
            const num = /\d{3,}/.exec(name)?.[0];
            if (num && lines.some((l) => new RegExp("(^|\\D)" + num + "(\\D|$)").test(l))) {
                found.add(e.name);
                continue;
            }
            // короткие имена — только почти точное совпадение
            const need = name.length <= 8 ? 0.9 : 0.8;
            if (lines.some((l) => bestInLine(name, l) >= need)) found.add(e.name);
        }
    }
    return found.size ? [...found] : null;
}
