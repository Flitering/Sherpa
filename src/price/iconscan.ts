// Распознавание предмета по картинке — подход RatScanner (RatEye), но без клика.
//
// RatScanner по Shift+клику находит выделенную игрой клетку по цвету выделения, вырезает её
// и сравнивает с картинками всех предметов того же размера в клетках. Игра подсвечивает и клетку
// под курсором (ровный светло-серый фон), поэтому здесь то же самое делается при наведении:
//  1. от курсора ищется подсвеченный прямоугольник — его размер в клетках даёт размер предмета;
//  2. вырезанная картинка уменьшается до «отпечатка» (SIG×SIG точек на клетку);
//  3. отпечаток сравнивается с отпечатками картинок tarkov.dev того же размера (и повёрнутых).
// Фон на обеих картинках приводится к одному цвету (в игре он подсвечен, у tarkov.dev — цвета категории),
// подписи, счётчики и курсор мыши в сравнение не входят.
//
// Похожие картинки (патроны, чёрные магазины) так не различить — тогда решает текст, а картинка
// и размер клетки помогают выбрать из того, что прочиталось.

export interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Шаг клетки при высоте экрана 1080 (как BaseSlotSize в RatEye): 63 px, картинки tarkov.dev — 63·n+1. */
export const SLOT = 63;
/** Точек отпечатка на одну клетку. */
export const SIG = 24;

/** Почему клетка не найдена — для отладочных кадров. */
export let hoverMiss = "";

export interface HoverCell extends Box {
    /** Размер в клетках. */
    cw: number;
    ch: number;
}

/** Фон подсвеченной клетки: ровный серый средней яркости. */
const isHover = (r: number, g: number, b: number) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const l = 0.3 * r + 0.59 * g + 0.11 * b;
    return mx - mn <= 14 && l >= 60 && l <= 135;
};

/**
 * Подсвеченная клетка под курсором (cx, cy — в пикселях img, s — масштаб интерфейса).
 * Клетки разделены почти чёрным зазором, фон обычных клеток тоже тёмный, а у клетки под курсором
 * фон светло-серый. Поэтому от курсора заливаются все «не тёмные» точки: подсветка вместе с картинкой
 * предмета, до зазора. Рамка сплошной подсветки в залитом — прямоугольник предмета, его размер, кратный
 * шагу сетки, — размер в клетках; подсветка по краям подтверждает, что это клетка инвентаря,
 * а не другой светлый элемент интерфейса.
 */
export function findHoverCell(img: ImageData, cx: number, cy: number, s: number): HoverCell | null {
    const { width: W, height: H, data: d } = img;
    const pitch = SLOT * s;
    // окно поиска: самый большой предмет — 10×10 клеток, курсор где-то внутри
    const R = Math.round(pitch * 10);
    const x0 = Math.max(0, Math.round(cx) - R), y0 = Math.max(0, Math.round(cy) - R);
    const x1 = Math.min(W, Math.round(cx) + R), y1 = Math.min(H, Math.round(cy) + R);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    const lit = new Uint8Array(w * h); // не тёмная точка
    const hov = new Uint8Array(w * h); // цвет подсветки
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = ((y + y0) * W + x + x0) * 4;
            const r = d[i], g = d[i + 1], b = d[i + 2];
            if (Math.max(r, g, b) >= 42) lit[y * w + x] = 1;
            if (isHover(r, g, b)) hov[y * w + x] = 1;
        }
    // сплошная подсветка: тонкие светлые линии (контур ячейки разгрузки, рамки) убираются «открытием» —
    // сжатием и расширением маски; остаётся заливка фона вокруг картинки предмета
    const solid = open(hov, w, h, Math.max(1, Math.round(1.5 * s)));
    // от курсора по кольцам: каждая ещё не залитая точка подсветки — начало заливки; берётся область,
    // где подсветки больше всего (курсор мыши и сама картинка могут отрезать маленькие кусочки фона)
    const lx = Math.round(cx) - x0, ly = Math.round(cy) - y0;
    const near = Math.round(0.6 * pitch);
    const seen = new Uint8Array(w * h);
    const stack: number[] = [];
    let best: { x0: number; y0: number; x1: number; y1: number; hov: number } | null = null;
    for (let rr = 0; rr <= near; rr++)
        for (let dy = -rr; dy <= rr; dy++)
            for (let dx = -rr; dx <= rr; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== rr) continue;
                const sx = lx + dx, sy = ly + dy;
                if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
                const start = sy * w + sx;
                if (!solid[start] || seen[start]) continue;
                const c = { x0: w, y0: h, x1: -1, y1: -1, hov: 0 };
                seen[start] = 1;
                stack.push(start);
                while (stack.length) {
                    const p = stack.pop()!;
                    const x = p % w, y = (p - x) / w;
                    // рамка — по подсветке: у ячеек разгрузки светлый контур обводит и пустую часть ячейки
                    if (solid[p]) {
                        if (x < c.x0) c.x0 = x;
                        if (x > c.x1) c.x1 = x;
                        if (y < c.y0) c.y0 = y;
                        if (y > c.y1) c.y1 = y;
                        c.hov++;
                    }
                    if (x > 0 && lit[p - 1] && !seen[p - 1]) (seen[p - 1] = 1), stack.push(p - 1);
                    if (x < w - 1 && lit[p + 1] && !seen[p + 1]) (seen[p + 1] = 1), stack.push(p + 1);
                    if (y > 0 && lit[p - w] && !seen[p - w]) (seen[p - w] = 1), stack.push(p - w);
                    if (y < h - 1 && lit[p + w] && !seen[p + w]) (seen[p + w] = 1), stack.push(p + w);
                }
                if (!best || c.hov > best.hov) best = c;
            }
    if (!best || best.x1 < 0) return (hoverMiss = "нет подсветки у курсора"), null;
    const { x0: bx0, y0: by0, x1: bx1, y1: by1 } = best;
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    hoverMiss = `рамка ${bw}×${bh} от (${bx0 + x0}, ${by0 + y0})`;
    // упёрлось в край кадра — предмет виден не целиком
    if (bx0 + x0 <= 0 || by0 + y0 <= 0 || bx1 + x0 >= W - 1 || by1 + y0 >= H - 1) return (hoverMiss += ", у края кадра"), null;
    const cw = Math.round(bw / pitch), ch = Math.round(bh / pitch);
    if (cw < 1 || ch < 1 || cw > 10 || ch > 10) return null;
    // рамка кратна клетке (у ячеек разгрузки и карманов рамка чуть больше шага сетки)
    if (Math.abs(bw - cw * pitch) > 0.2 * pitch || Math.abs(bh - ch * pitch) > 0.2 * pitch) return (hoverMiss += ", не кратна клетке"), null;
    // по краям — подсветка: так выглядит только клетка под курсором
    const edge = (ax: number, ay: number, bx: number, by: number) => {
        let n = 0, k = 0;
        for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) (n++, (k += hov[y * w + x]));
        return k / Math.max(1, n);
    };
    const band = Math.max(2, Math.round(3 * s));
    const edges = [
        edge(bx0, by0, bx1, by0 + band - 1),
        edge(bx0, by1 - band + 1, bx1, by1),
        edge(bx0, by0, bx0 + band - 1, by1),
        edge(bx1 - band + 1, by0, bx1, by1),
    ];
    // картинка или подпись может доходить до края — достаточно трёх краёв из четырёх
    if (edges.filter((e) => e >= 0.5).length < 3) return (hoverMiss += `, края ${edges.map((e) => e.toFixed(2)).join(" ")}`), null;
    hoverMiss = "";
    return { x: bx0 + x0, y: by0 + y0, w: bw, h: bh, cw, ch };
}

/** Морфологическое открытие квадратом (2r+1): сжатие, затем расширение. */
function open(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
    const pass = (src: Uint8Array, keep: 0 | 1) => {
        // keep=1: сжатие (точка остаётся, если весь квадрат — маска), keep=0: расширение
        const t = new Uint8Array(w * h), out = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            let run = 0;
            for (let x = 0; x < w + r; x++) {
                // скользящее окно по строке: число точек маски в [x-2r, x]
                if (x < w) run += src[y * w + x];
                if (x - 2 * r - 1 >= 0) run -= src[y * w + x - 2 * r - 1];
                const c = x - r;
                if (c < 0 || c >= w) continue;
                const n = Math.min(x, w - 1) - Math.max(0, x - 2 * r) + 1;
                t[y * w + c] = keep ? (run === n ? 1 : 0) : run > 0 ? 1 : 0;
            }
        }
        for (let x = 0; x < w; x++) {
            let run = 0;
            for (let y = 0; y < h + r; y++) {
                if (y < h) run += t[y * w + x];
                if (y - 2 * r - 1 >= 0) run -= t[(y - 2 * r - 1) * w + x];
                const c = y - r;
                if (c < 0 || c >= h) continue;
                const n = Math.min(y, h - 1) - Math.max(0, y - 2 * r) + 1;
                out[c * w + x] = keep ? (run === n ? 1 : 0) : run > 0 ? 1 : 0;
            }
        }
        return out;
    };
    return pass(pass(m, 1), 0);
}

// ---------------- отпечатки ----------------

/**
 * Отпечаток: цвет каждой точки (фон заменён одним цветом BG), признак «здесь предмет» и
 * признак «точка участвует в сравнении» (не подпись и не курсор мыши).
 */
export interface Sig {
    cw: number;
    ch: number;
    rgb: Uint8Array; // (cw·SIG)·(ch·SIG)·3
    fg: Uint8Array; // 1 — предмет, 0 — фон
    use: Uint8Array; // 1 — сравнивать
}

/** Общий цвет фона: тёмный, как фон клеток, — тёмная деталь, принятая за фон, почти не штрафуется. */
const BG = 24;

type IsBg = (r: number, g: number, b: number) => boolean;

/**
 * Отпечаток прямоугольника картинки: каждая точка — среднее по своему квадрату, фоновые пиксели
 * считаются цветом BG. Без сравнения: короткое имя (верхняя полоса), счётчик или прочность
 * (низ правой клетки) и точки, для которых skip(x, y) — там курсор мыши.
 */
export function makeSig(img: ImageData, box: Box, cw: number, ch: number, isBg: IsBg, skip?: (x: number, y: number) => boolean): Sig {
    const W = cw * SIG, H = ch * SIG;
    const rgb = new Uint8Array(W * H * 3);
    const fg = new Uint8Array(W * H);
    const use = new Uint8Array(W * H);
    const { width: IW, data: d } = img;
    const sx = box.w / W, sy = box.h / H;
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
            const ax = Math.floor(box.x + x * sx), bx = Math.max(ax + 1, Math.floor(box.x + (x + 1) * sx));
            const ay = Math.floor(box.y + y * sy), by = Math.max(ay + 1, Math.floor(box.y + (y + 1) * sy));
            let r = 0, g = 0, b = 0, n = 0, nf = 0, skipped = false;
            for (let yy = ay; yy < by; yy++)
                for (let xx = ax; xx < bx; xx++) {
                    if (skip?.(xx, yy)) skipped = true;
                    const i = (yy * IW + xx) * 4;
                    n++;
                    if (isBg(d[i], d[i + 1], d[i + 2])) {
                        r += BG;
                        g += BG;
                        b += BG;
                    } else {
                        r += d[i];
                        g += d[i + 1];
                        b += d[i + 2];
                        nf++;
                    }
                }
            const p = y * W + x;
            rgb[p * 3] = r / n;
            rgb[p * 3 + 1] = g / n;
            rgb[p * 3 + 2] = b / n;
            fg[p] = nf * 2 > n ? 1 : 0;
            const inName = y < SIG * 0.25;
            const inCount = y >= H - SIG * 0.25 && x >= W - SIG;
            use[p] = inName || inCount || skipped ? 0 : 1;
        }
    return { cw, ch, rgb, fg, use };
}

/** Фон подсвеченной клетки в игре. */
export const isHoverBg: IsBg = isHover;

/**
 * Фон картинки tarkov.dev: у каждой категории предметов свой цвет фона, поэтому он берётся
 * с картинки — медиана полосы у края (внутри рамки), без верхнего правого угла с подписью.
 */
export function gridBg(img: ImageData): IsBg {
    const { width: W, height: H, data: d } = img;
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    const add = (x: number, y: number) => {
        const i = (y * W + x) * 4;
        rs.push(d[i]);
        gs.push(d[i + 1]);
        bs.push(d[i + 2]);
    };
    for (let k = 2; k <= 4; k++) {
        for (let x = 2; x < W - 2; x++) add(x, H - 1 - k); // низ
        for (let y = 2; y < H - 2; y++) add(k, y); // левый край
        for (let x = 2; x < W / 2; x++) add(x, k); // верх слева (справа — подпись)
    }
    const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1] ?? 0;
    const R = med(rs), G = med(gs), B = med(bs);
    return (r, g, b) => Math.abs(r - R) <= 16 && Math.abs(g - G) <= 16 && Math.abs(b - B) <= 16;
}

/** Поворот отпечатка на 90° по часовой (предмет в инвентаре можно положить боком). */
export function rotateSig(s: Sig): Sig {
    const W = s.cw * SIG, H = s.ch * SIG;
    const rgb = new Uint8Array(s.rgb.length);
    const fg = new Uint8Array(s.fg.length);
    const use = new Uint8Array(s.use.length);
    // новая ширина — H, высота — W; точка (x,y) → (H-1-y, x)
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
            const p = y * W + x, q = x * H + (H - 1 - y);
            rgb[q * 3] = s.rgb[p * 3];
            rgb[q * 3 + 1] = s.rgb[p * 3 + 1];
            rgb[q * 3 + 2] = s.rgb[p * 3 + 2];
            fg[q] = s.fg[p];
            use[q] = s.use[p];
        }
    return { cw: s.ch, ch: s.cw, rgb, fg, use };
}

/**
 * Похожесть отпечатков 0…1 там, где предмет есть хотя бы на одной картинке (фон на обеих одинаков
 * и ничего не говорит): в основном форма — корреляция яркости, немного — разница цвета. Сдвиг на ±1 точку прощается — рамки у игры
 * и у tarkov.dev чуть разные.
 */
export function similarity(a: Sig, b: Sig): number {
    if (a.cw !== b.cw || a.ch !== b.ch) return 0;
    const W = a.cw * SIG, H = a.ch * SIG;
    const lum = (r: Uint8Array, p: number) => 0.3 * r[p * 3] + 0.59 * r[p * 3 + 1] + 0.11 * r[p * 3 + 2];
    let best = 0;
    for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
            let n = 0, diff = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
            for (let y = 1; y < H - 1; y++)
                for (let x = 1; x < W - 1; x++) {
                    const p = y * W + x, q = (y + oy) * W + x + ox;
                    if (!a.use[p] || !b.use[q] || (!a.fg[p] && !b.fg[q])) continue;
                    n++;
                    diff += Math.abs(a.rgb[p * 3] - b.rgb[q * 3]) + Math.abs(a.rgb[p * 3 + 1] - b.rgb[q * 3 + 1]) + Math.abs(a.rgb[p * 3 + 2] - b.rgb[q * 3 + 2]);
                    const la = lum(a.rgb, p), lb = lum(b.rgb, q);
                    sa += la;
                    sb += lb;
                    saa += la * la;
                    sbb += lb * lb;
                    sab += la * lb;
                }
            if (n < 12) continue;
            const color = 1 - Math.min(1, diff / n / 3 / 64);
            // форма: корреляция яркости (не зависит от общей яркости и контраста)
            const cov = sab / n - (sa / n) * (sb / n);
            const va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
            const ncc = va > 1 && vb > 1 ? cov / Math.sqrt(va * vb) : 0;
            const score = 0.2 * color + 0.8 * Math.max(0, ncc);
            if (score > best) best = score;
        }
    return best;
}

// ---------------- индекс картинок предметов ----------------

export interface IconItem {
    id: string;
    w: number;
    h: number;
}

/** Предмет помещается в клетку как есть или повёрнутым. */
export const fits = (it: IconItem, cw: number, ch: number) => (it.w === cw && it.h === ch) || (it.w === ch && it.h === cw);

/**
 * Отпечатки картинок tarkov.dev. Картинки грузятся по запросу: сначала те, на которые указал текст
 * (их несколько), а все предметы нужного размера — в фоне, после первой встречи с этим размером.
 */
export class IconIndex<T extends IconItem> {
    private sigs = new Map<string, Sig | null>(); // null — картинки нет
    private sizes = new Map<string, Promise<void>>();
    private done = new Set<string>();

    /** load бросает ошибку с missing: true, если картинки у предмета нет совсем. */
    constructor(private load: (id: string) => Promise<ImageData>) {}

    /** Отпечаток картинки предмета; null — картинки нет. Сбой сети не запоминается: в другой раз попробуем снова. */
    private async sigOf(it: T): Promise<Sig | null> {
        if (this.sigs.has(it.id)) return this.sigs.get(it.id)!;
        try {
            const im = await this.load(it.id);
            const sig = makeSig(im, { x: 0, y: 0, w: im.width, h: im.height }, it.w, it.h, gridBg(im));
            this.sigs.set(it.id, sig);
            return sig;
        } catch (e) {
            if ((e as { missing?: boolean }).missing) this.sigs.set(it.id, null);
            else this.failed = true;
            return null;
        }
    }
    private failed = false;

    /** Загрузить отпечатки этих предметов (кандидатов по тексту). */
    async prepare(items: T[]) {
        await Promise.all(items.map((it) => this.sigOf(it)));
    }

    /**
     * Все предметы размера cw×ch (и повёрнутые) — в фоне, по две картинки за раз (сервер картинок
     * обрывает частые запросы; скачанные хранятся на диске, так что это один раз). true — уже все.
     */
    prepareSize(all: T[], cw: number, ch: number): boolean {
        const key = cw <= ch ? `${cw}x${ch}` : `${ch}x${cw}`;
        if (this.done.has(key)) return true;
        if (!this.sizes.has(key)) {
            const list = all.filter((it) => fits(it, cw, ch) && !this.sigs.has(it.id));
            let i = 0;
            this.failed = false;
            const work = async () => {
                // сеть сбоит — остановиться; при следующей встрече с этим размером продолжим
                while (i < list.length && !this.failed) await this.sigOf(list[i++]);
            };
            this.sizes.set(
                key,
                Promise.all([work(), work()]).then(() => {
                    if (this.failed) this.sizes.delete(key);
                    else this.done.add(key);
                }),
            );
        }
        return false;
    }

    /** Похожесть отпечатка клетки на уже загруженные картинки предметов — по убыванию. */
    rank(sig: Sig, items: T[]): { item: T; score: number }[] {
        const out: { item: T; score: number }[] = [];
        for (const it of items) {
            const ref = this.sigs.get(it.id);
            if (!ref) continue;
            let score = 0;
            if (ref.cw === sig.cw && ref.ch === sig.ch) score = similarity(sig, ref);
            if (ref.cw === sig.ch && ref.ch === sig.cw && sig.cw !== sig.ch) {
                // повёрнут — в какую сторону, неизвестно: обе
                const r = rotateSig(ref);
                score = Math.max(score, similarity(sig, r), similarity(sig, rotateSig(rotateSig(r))));
            }
            out.push({ item: it, score });
        }
        return out.sort((a, b) => b.score - a.score);
    }
}
