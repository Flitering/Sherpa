// Формат пакета данных, который собирает scripts/sync-data.mjs

export type GameMode = "regular" | "pve";

export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

/** Контур зоны: пары [x, z] в игровых координатах. */
export type Outline = [number, number][];

export interface Zone {
    map: string;
    position: Vec3;
    outline?: Outline;
    top?: number;
    bottom?: number;
}

export interface Objective {
    id: string;
    type: string;
    text: string;
    optional: boolean;
    count?: number;
    maps: string[];
    zones?: Zone[];
    locations?: { map: string; positions: Vec3[] }[];
    items?: string[];
    fir?: boolean;
    markerItem?: string;
    questItem?: string;
    /** Варианты ключей: внешний массив — «нужен любой из наборов». */
    keys?: string[][];
    exitName?: string;
    targets?: string[];
    skill?: { name: string; level: number };
    task?: string;
}

export interface Task {
    id: string;
    name: string;
    trader: string;
    map: string | null;
    minPlayerLevel: number;
    /** Требования к торговцу: уровень доверия (level) или репутация (reputation). */
    traderReq?: { trader: string; type: string; value: number }[];
    /** Открывается по сюжету (диалог или сюжетное событие), а не по уровню. */
    story?: boolean;
    kappa: boolean;
    lightkeeper: boolean;
    faction: string;
    wiki?: string;
    image?: string;
    experience: number;
    requires: { task: string; status: string[] }[];
    neededKeys: { map?: string; keys: string[] }[];
    objectives: Objective[];
}

export interface Item {
    name: string;
    short: string;
    icon?: string;
    image?: string;
    wiki?: string;
    link?: string;
    quest?: boolean;
}

export interface LayerExtent {
    height: [number, number];
    bounds?: [[number, number], [number, number]][];
}

export interface MapLayer {
    name: string;
    svgLayer?: string;
    tilePath?: string;
    show: boolean;
    extents?: LayerExtent[];
}

export interface MapDisplay {
    key: string;
    transform?: [number, number, number, number];
    coordinateRotation: number;
    bounds: [[number, number], [number, number]];
    svgBounds?: [[number, number], [number, number]];
    svgPath?: string;
    svgLayer?: string;
    tilePath?: string;
    tileSize?: number;
    minZoom: number;
    maxZoom: number;
    heightRange?: [number, number];
    layers: MapLayer[];
    labels: MapLabel[];
    author?: string;
    authorLink?: string;
}

export interface MapLabel {
    x: number;
    z: number;
    text: string;
    rotation: number;
    size: number;
}

export interface MapPoint {
    name: string;
    nameEn?: string;
    position: Vec3;
    outline?: Outline;
    faction?: string;
    /** Платный выход: id предмета и количество. */
    paid?: { item: string; count: number };
    needsSwitch?: boolean;
}

export interface Hazard {
    /** minefield, sniper, hazard */
    type: string;
    name: string;
    position: Vec3;
    outline?: Outline;
}

export interface StationaryWeapon {
    /** utes — НСВ «Утёс», ags — АГС-30 */
    type: "utes" | "ags" | "mg";
    name: string;
    position: Vec3;
}

export interface GameMap {
    key: string;
    ids: string[];
    name: string;
    variants: { id: string; key: string; nameId: string; name: string }[];
    wiki?: string;
    raidDuration?: number;
    players?: string;
    minPlayerLevel?: number;
    bosses: string[];
    display: MapDisplay;
    extracts: MapPoint[];
    transits: MapPoint[];
    spawns: { zone: string; position: Vec3 }[];
    hazards: Hazard[];
    stationary: StationaryWeapon[];
    /** Зоны миномётного обстрела. */
    artillery: { position: Vec3; outline?: Outline }[];
}

export interface Bundle {
    mode: GameMode;
    lang: string;
    generatedAt: string;
    source: string;
    maps: GameMap[];
    tasks: Task[];
    items: Record<string, Item>;
    traders: Record<string, { name: string; key: string; image?: string }>;
}

// ---------- прогресс игроков ----------

export type TaskStatus = "active" | "done";

export interface Player {
    id: string;
    name: string;
    color: string;
    level: number;
    tasks: Record<string, TaskStatus>;
    objectivesDone: Record<string, true>;
}
