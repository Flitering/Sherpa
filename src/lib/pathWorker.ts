// Web Worker: поиск путей по сетке проходимости без блокировки интерфейса.
//
// Чтобы маршрут выглядел «по-человечески», как в навигаторах:
//  1. Отступ от стен. Для каждой клетки считается расстояние до ближайшего препятствия
//     (стена, здание, вода…). Клетки у стен дороже — путь идёт по середине улицы или прохода,
//     а не трётся об углы домов.
//  2. Штраф за повороты (как turn penalty в OSRM/Valhalla). Поиск помнит направление движения;
//     каждый поворот стоит дополнительных метров, резкий — дороже. Получаются длинные прямые
//     участки с поворотами на перекрёстках, без зигзагов.
//  3. Упрощение линии: остаются только настоящие повороты (Дуглас–Пекер с допуском ~1.2 м),
//     и каждый упрощённый отрезок проверяется на проходимость.
//
// Матрица расстояний между точками считается быстрым поиском без учёта поворотов (для порядка
// обхода), а сами линии маршрута — точным поиском с поворотами.

export {};

let W = 0;
let H = 0;
let CELL = 1;
let cost = new Uint8Array(0);
/** Множитель шага клетки: стоимость поверхности × штраф за близость к стенам. */
let factor = new Float32Array(0);
let dist = new Float64Array(0);
let prevCell = new Int32Array(0);
let settled = new Uint8Array(0);

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];
const DL = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];

/** Отступ от стен: в пределах CLEAR_M метров шаг дороже, у самой стены — в (1 + CLEAR_K) раз. */
const CLEAR_M = 3.5;
const CLEAR_K = 1.6;
/** Что считается «стеной» для отступа: непроходимое и здания (дороже этой стоимости). */
const OBSTACLE_COST = 60;
/** Штраф за поворот, метров пути, по величине поворота (в шагах по 45°). */
const TURN_M = [0, 0.8, 4, 12, 30];

// ---- двоичная куча (ключ — Float64, значение — номер состояния) ----
let hk = new Float64Array(1024);
let hv = new Int32Array(1024);
let hn = 0;
function push(k: number, v: number) {
    if (hn >= hk.length) {
        const k2 = new Float64Array(hk.length * 2);
        k2.set(hk);
        hk = k2;
        const v2 = new Int32Array(hv.length * 2);
        v2.set(hv);
        hv = v2;
    }
    let i = hn++;
    while (i > 0) {
        const p = (i - 1) >> 1;
        if (hk[p] <= k) break;
        hk[i] = hk[p];
        hv[i] = hv[p];
        i = p;
    }
    hk[i] = k;
    hv[i] = v;
}
function pop(): number {
    const top = hv[0];
    const k = hk[--hn];
    const v = hv[hn];
    let i = 0;
    for (;;) {
        let c = 2 * i + 1;
        if (c >= hn) break;
        if (c + 1 < hn && hk[c + 1] < hk[c]) c++;
        if (hk[c] >= k) break;
        hk[i] = hk[c];
        hv[i] = hv[c];
        i = c;
    }
    hk[i] = k;
    hv[i] = v;
    return top;
}

/** Расстояние до ближайшего препятствия (метры), двухпроходный chamfer 3-4. */
function clearance(): Float32Array {
    const INF = 1e9;
    const d = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) d[i] = !cost[i] || cost[i] > OBSTACLE_COST ? 0 : INF;
    const relax = (i: number, j: number, w: number) => {
        if (d[j] + w < d[i]) d[i] = d[j] + w;
    };
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
            const i = y * W + x;
            if (!d[i]) continue;
            if (x > 0) relax(i, i - 1, 3);
            if (y > 0) {
                relax(i, i - W, 3);
                if (x > 0) relax(i, i - W - 1, 4);
                if (x < W - 1) relax(i, i - W + 1, 4);
            }
        }
    for (let y = H - 1; y >= 0; y--)
        for (let x = W - 1; x >= 0; x--) {
            const i = y * W + x;
            if (!d[i]) continue;
            if (x < W - 1) relax(i, i + 1, 3);
            if (y < H - 1) {
                relax(i, i + W, 3);
                if (x < W - 1) relax(i, i + W + 1, 4);
                if (x > 0) relax(i, i + W - 1, 4);
            }
        }
    for (let i = 0; i < W * H; i++) d[i] = (d[i] / 3) * CELL;
    return d;
}

function buildFactor() {
    const clr = clearance();
    factor = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
        if (!cost[i]) continue;
        const near = Math.max(0, CLEAR_M - clr[i]) / CLEAR_M;
        factor[i] = (cost[i] / 10) * (1 + CLEAR_K * near * near);
    }
}

/** Ближайшая проходимая клетка (точка может стоять в стене или за краем). */
function snap(c: number): number {
    if (cost[c]) return c;
    const cx = c % W;
    const cy = (c / W) | 0;
    for (let r = 1; r < 40; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const x = cx + dx;
                const y = cy + dy;
                if (x < 0 || y < 0 || x >= W || y >= H) continue;
                const n = y * W + x;
                if (cost[n]) return n;
            }
        }
    }
    return c;
}

const step = (a: number, b: number, k: number) => ((factor[a] + factor[b]) / 2) * DL[k] * CELL;

/** Быстрый поиск без учёта поворотов: Дейкстра (много целей) или A* (одна цель). */
function search(source: number, targets: Set<number>, goal?: number) {
    dist.fill(Infinity);
    prevCell.fill(-1);
    settled.fill(0);
    hn = 0;
    dist[source] = 0;
    const gx = goal !== undefined ? goal % W : 0;
    const gy = goal !== undefined ? (goal / W) | 0 : 0;
    const h = (c: number) => (goal === undefined ? 0 : Math.hypot((c % W) - gx, ((c / W) | 0) - gy) * CELL);
    push(h(source), source);
    let left = targets.size;
    while (hn > 0) {
        const c = pop();
        if (settled[c]) continue;
        settled[c] = 1;
        if (targets.has(c) && --left <= 0) break;
        const cx = c % W;
        const cy = (c / W) | 0;
        for (let k = 0; k < 8; k++) {
            const x = cx + DX[k];
            const y = cy + DY[k];
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            const n = y * W + x;
            if (!cost[n] || settled[n]) continue;
            if (k & 1 && (!cost[cy * W + x] || !cost[y * W + cx])) continue; // не срезаем углы
            const nd = dist[c] + step(c, n, k);
            if (nd < dist[n]) {
                dist[n] = nd;
                prevCell[n] = c;
                push(nd + h(n), n);
            }
        }
    }
}

function trace(target: number): number[] {
    const out: number[] = [];
    for (let c = target; c !== -1; c = prevCell[c]) out.push(c);
    return out.reverse();
}

/**
 * Точный путь с учётом поворотов: состояние = (клетка, направление прихода).
 * A* с евклидовой эвристикой; поворот на 45°·t стоит TURN_M[t] метров.
 */
let tDist = new Float32Array(0);
let tPrev = new Int32Array(0);
let tDone = new Uint8Array(0);
function humanPath(a: number, b: number): number[] | null {
    const N = W * H;
    if (tDist.length !== N * 8) {
        tDist = new Float32Array(N * 8);
        tPrev = new Int32Array(N * 8);
        tDone = new Uint8Array(N * 8);
    }
    tDist.fill(Infinity);
    tPrev.fill(-1);
    tDone.fill(0);
    hn = 0;
    const gx = b % W;
    const gy = (b / W) | 0;
    const h = (c: number) => Math.hypot((c % W) - gx, ((c / W) | 0) - gy) * CELL;
    // стартуем во все стороны без штрафа
    const ax = a % W;
    const ay = (a / W) | 0;
    for (let k = 0; k < 8; k++) {
        const x = ax + DX[k];
        const y = ay + DY[k];
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const n = y * W + x;
        if (!cost[n]) continue;
        if (k & 1 && (!cost[ay * W + x] || !cost[y * W + ax])) continue;
        const s = n * 8 + k;
        const d = step(a, n, k);
        if (d < tDist[s]) {
            tDist[s] = d;
            tPrev[s] = -2 - a; // начало пути
            push(d + h(n), s);
        }
    }
    let end = -1;
    let guard = 0;
    while (hn > 0) {
        const s = pop();
        if (tDone[s]) continue;
        tDone[s] = 1;
        const c = (s / 8) | 0;
        const dir = s - c * 8;
        if (c === b) {
            end = s;
            break;
        }
        if (++guard > N * 6) break; // защита от бесконечного перебора на огромной карте
        const cx = c % W;
        const cy = (c / W) | 0;
        for (let k = 0; k < 8; k++) {
            const x = cx + DX[k];
            const y = cy + DY[k];
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            const n = y * W + x;
            if (!cost[n]) continue;
            if (k & 1 && (!cost[cy * W + x] || !cost[y * W + cx])) continue;
            let turn = Math.abs(k - dir);
            if (turn > 4) turn = 8 - turn;
            const ns = n * 8 + k;
            if (tDone[ns]) continue;
            const nd = tDist[s] + step(c, n, k) + TURN_M[turn];
            if (nd < tDist[ns]) {
                tDist[ns] = nd;
                tPrev[ns] = s;
                push(nd + h(n), ns);
            }
        }
    }
    if (end < 0) return null;
    const out: number[] = [];
    let s = end;
    for (;;) {
        out.push((s / 8) | 0);
        const p = tPrev[s];
        if (p <= -2) {
            out.push(-2 - p);
            break;
        }
        s = p;
    }
    return out.reverse();
}

/** Отрезок проходим: все клетки непроходимые не задеты, дороже limit — нет. */
function clearLine(a: number, b: number, limit: number): boolean {
    let x0 = a % W, y0 = (a / W) | 0;
    const x1 = b % W, y1 = (b / W) | 0;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
        const c = cost[y0 * W + x0];
        if (!c || c > limit) return false;
        if (x0 === x1 && y0 === y1) return true;
        const e2 = 2 * err;
        if (e2 >= dy) {
            err += dy;
            x0 += sx;
        }
        if (e2 <= dx) {
            err += dx;
            y0 += sy;
        }
    }
}

/**
 * Упрощение Дугласа–Пекера: оставляем вершины, отклонение от которых больше tol,
 * и только если упрощённый отрезок не дороже исходного участка.
 */
function simplify(path: number[], tolM = 1.2): Int32Array {
    if (path.length < 3) return Int32Array.from(path);
    const tol = tolM / CELL;
    const keep = new Uint8Array(path.length);
    keep[0] = keep[path.length - 1] = 1;
    const stack: [number, number][] = [[0, path.length - 1]];
    while (stack.length) {
        const [i, j] = stack.pop()!;
        if (j - i < 2) continue;
        const ax = path[i] % W, ay = (path[i] / W) | 0;
        const bx = path[j] % W, by = (path[j] / W) | 0;
        const len = Math.hypot(bx - ax, by - ay) || 1;
        let worst = -1;
        let wd = 0;
        let maxCost = 0;
        for (let k = i + 1; k < j; k++) {
            const px = path[k] % W, py = (path[k] / W) | 0;
            const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
            if (d > wd) {
                wd = d;
                worst = k;
            }
            maxCost = Math.max(maxCost, cost[path[k]]);
        }
        const limit = Math.max(cost[path[i]], cost[path[j]], maxCost);
        if (wd > tol || !clearLine(path[i], path[j], limit)) {
            const k = worst > 0 ? worst : (i + j) >> 1;
            keep[k] = 1;
            stack.push([i, k], [k, j]);
        }
    }
    return Int32Array.from(path.filter((_, k) => keep[k]));
}

/** Геометрическая длина ломаной по клеткам, м. */
function meters(path: ArrayLike<number>): number {
    let m = 0;
    for (let i = 1; i < path.length; i++) {
        const a = path[i - 1];
        const b = path[i];
        m += Math.hypot((a % W) - (b % W), ((a / W) | 0) - ((b / W) | 0));
    }
    return m * CELL;
}

/** Путь a→b «по-человечески»; если точный поиск не справился — быстрый. */
function route(a: number, b: number): Int32Array | null {
    const p = humanPath(a, b);
    if (p) return simplify(p);
    search(a, new Set([b]), b);
    return dist[b] < Infinity ? simplify(trace(b)) : null;
}

const post = (msg: object) => (self as unknown as Worker).postMessage(msg);

self.onmessage = (e: MessageEvent) => {
    const m = e.data;
    try {
        if (m.type === "init") {
            W = m.w;
            H = m.h;
            CELL = m.cellMeters;
            cost = m.cost;
            dist = new Float64Array(W * H);
            prevCell = new Int32Array(W * H);
            settled = new Uint8Array(W * H);
            buildFactor();
            return;
        }
        if (m.type === "matrix") {
            // быстрая матрица «стоимостей» для выбора порядка точек
            const cells: number[] = m.cells.map(snap);
            const n = cells.length;
            const out = new Float64Array(n * n).fill(Infinity);
            const len = new Float64Array(n * n).fill(Infinity);
            const paths: (Int32Array | null)[] = new Array(n * n).fill(null);
            for (let i = 0; i < n; i++) {
                out[i * n + i] = 0;
                len[i * n + i] = 0;
                const targets = new Set(cells.filter((_, j) => j > i));
                if (!targets.size) continue;
                search(cells[i], targets);
                for (let j = i + 1; j < n; j++) {
                    const d = dist[cells[j]];
                    out[i * n + j] = out[j * n + i] = d;
                    if (d < Infinity) {
                        const p = simplify(trace(cells[j]));
                        paths[i * n + j] = p;
                        len[i * n + j] = len[j * n + i] = meters(p);
                    }
                }
            }
            post({ id: m.id, result: { dist: out, len, paths } });
            return;
        }
        if (m.type === "path") {
            const cells = route(snap(m.from), snap(m.to));
            post({ id: m.id, result: cells ? { cells, length: meters(cells) } : null });
            return;
        }
        if (m.type === "legs") {
            // линии маршрута для отрезков: точный поиск с поворотами
            const result = (m.pairs as [number, number][]).map(([a, b]) => {
                const cells = route(snap(a), snap(b));
                return cells ? { cells, length: meters(cells) } : null;
            });
            post({ id: m.id, result });
        }
    } catch (err) {
        post({ id: m.id, error: String(err) });
    }
};
