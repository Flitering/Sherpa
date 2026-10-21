import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Bundle, GameMode, Player, Task, TaskStatus, Vec3 } from "./types";
import { usePersistentState } from "./lib/store";
import { activeStops, loadout, objectivePoints, taskOnMap } from "./lib/quests";
import { DEFAULT_RAID_SETTINGS, planRaids, type Raid, type RaidPlan, type RaidSettings, type RaidStep } from "./lib/raids";
import { refineRaids } from "./lib/realRoutes";
import { loadSvgText, useNavGrid } from "./lib/useNavGrid";
import { detailRoute, type DetailRoute } from "./lib/navdetail";
import { dist as straightDist } from "./lib/route";
import {
    ensurePermission,
    loadHandle,
    pickDirectory,
    saveHandle,
    watchScreenshots,
    type PlayerFix,
} from "./lib/navigator";
import MapView, { type MapFocus } from "./components/MapView";
import QuestsTab from "./components/QuestsTab";
import RaidsTab from "./components/RaidsTab";
import LoadoutTab from "./components/LoadoutTab";
import PlayersTab from "./components/PlayersTab";
import NavigatorTab, { type NavLink } from "./components/NavigatorTab";
import Hud, { type Session } from "./components/Hud";
import QuestScan from "./components/QuestScan";
import MarketTab from "./components/MarketTab";
import PriceTip from "./components/PriceTip";
import { loadMarket, MarketContext, refreshMarket, type Market } from "./lib/market";
import { scanTaskHistory, watchLogs, type LogState } from "./lib/gamelogs";
import { applyActiveList, applyTaskEvents, type SyncSummary } from "./lib/progressSync";

type Tab = "quests" | "raids" | "loadout" | "market" | "nav" | "players";
type Which = "shots" | "logs";

export default function App() {
    const [state, setState] = usePersistentState();
    const [bundle, setBundle] = useState<Bundle | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useState<Tab>("quests");
    const [focus, setFocus] = useState<MapFocus>();

    // планирование
    const [selectedRaid, setSelectedRaid] = useState<Record<string, number | null>>({});
    const [extractOverride, setExtractOverride] = useState<Record<string, Record<number, string>>>({});
    const [includeShoot, setIncludeShoot] = useState(false);
    const [showOther, setShowOther] = useState(false);
    const [showExtracts, setShowExtracts] = useState(true);
    const [showLabels, setShowLabels] = useState(true);
    const raidSettings: RaidSettings = state.raidSettings ?? DEFAULT_RAID_SETTINGS;

    // навигатор
    const [session, setSession] = useState<Session>();
    const [fix, setFix] = useState<PlayerFix & { mapKey: string }>();
    const [logState, setLogState] = useState<LogState>();
    const [links, setLinks] = useState<Record<Which, NavLink>>({ shots: { status: "off" }, logs: { status: "off" } });
    const [handles, setHandles] = useState<Partial<Record<Which, FileSystemDirectoryHandle>>>({});
    const [follow, setFollow] = useState(true);
    const [autoMap, setAutoMap] = useState(true);
    const [pip, setPip] = useState<Window | null>(null);
    const [now, setNow] = useState(Date.now());

    useEffect(() => {
        setBundle(null);
        setError(null);
        fetch(`${import.meta.env.BASE_URL}data/${state.mode}.json`)
            .then((r) => {
                if (!r.ok) throw new Error(`Нет файла данных (${r.status}). Запусти «npm run sync».`);
                return r.json();
            })
            .then(setBundle)
            .catch((e) => setError(e.message));
    }, [state.mode]);

    const gameMap = bundle?.maps.find((m) => m.key === state.mapKey) ?? bundle?.maps[0];
    const mapKey = gameMap?.key ?? "";
    const mapKeyRef = useRef(mapKey);
    mapKeyRef.current = mapKey;

    // ---------- цены ----------
    const [market, setMarket] = useState<Market | null>(null);
    const [tip, setTip] = useState<{ id: string; rect: DOMRect } | null>(null);
    useEffect(() => {
        setMarket(null);
        loadMarket(state.mode).then(setMarket).catch((e) => console.warn(e));
    }, [state.mode]);
    const marketCtx = useMemo(
        () => ({
            market,
            intel: !!state.intelCenter,
            traders: bundle?.traders ?? {},
            showTip: (id: string, rect: DOMRect) => setTip({ id, rect }),
            hideTip: () => setTip(null),
        }),
        [market, state.intelCenter, bundle],
    );

    // ---------- рейды ----------
    const stops = useMemo(() => (bundle && gameMap ? activeStops(bundle, state.players, mapKey, includeShoot) : []), [bundle, gameMap, state.players, mapKey, includeShoot]);
    const rawPlan: RaidPlan = useMemo(
        () => (gameMap ? planRaids(gameMap, stops, raidSettings, extractOverride[mapKey]) : { raids: [], budgetSec: 0, raidSec: 0 }),
        [gameMap, stops, raidSettings, extractOverride, mapKey],
    );

    // Реальные пути по сетке проходимости: считаются в фоне, до готовности — прямые линии.
    const { svc, status: navStatus } = useNavGrid(gameMap);
    const [refined, setRefined] = useState<{ from: RaidPlan; raids: Raid[] }>();
    useEffect(() => {
        if (!svc || !gameMap || !rawPlan.raids.length) return;
        let cancelled = false;
        refineRaids(svc, gameMap, rawPlan, raidSettings, extractOverride[mapKey])
            .then((raids) => !cancelled && setRefined({ from: rawPlan, raids }))
            .catch((e) => console.warn("Не удалось уточнить пути:", e));
        return () => {
            cancelled = true;
        };
    }, [svc, rawPlan, gameMap, raidSettings, extractOverride, mapKey]);
    const plan: RaidPlan = useMemo(() => (refined?.from === rawPlan ? { ...rawPlan, raids: refined.raids } : rawPlan), [refined, rawPlan]);
    const routesState = navStatus === "ready" ? (refined?.from === rawPlan || !rawPlan.raids.length ? "real" : "computing") : navStatus;
    const sel = selectedRaid[mapKey] ?? null;
    const setSel = (i: number | null) => setSelectedRaid((s) => ({ ...s, [mapKey]: i }));

    const sideTasks = useMemo(() => {
        if (!bundle) return [];
        const out: { task: Task; text: string; players: Player[] }[] = [];
        for (const task of bundle.tasks) {
            const owners = state.players.filter((p) => p.tasks[task.id] === "active");
            if (!owners.length) continue;
            for (const o of task.objectives) {
                if (!(o.maps.includes(mapKey) || (task.map === mapKey && !o.maps.length))) continue;
                if (objectivePoints(o, mapKey).length && !(o.type === "shoot" && !includeShoot)) continue;
                if (["giveItem", "giveQuestItem", "taskStatus", "traderLevel", "traderStanding", "skill", "sellItem", "buildWeapon"].includes(o.type)) continue;
                const who = owners.filter((p) => !p.objectivesDone[o.id]);
                if (who.length) out.push({ task, text: o.text, players: who });
            }
        }
        return out;
    }, [bundle, state.players, mapKey, includeShoot]);

    const otherTasks = useMemo(
        () => (bundle && showOther ? bundle.tasks.filter((t) => taskOnMap(t, mapKey) && !state.players.some((p) => p.tasks[t.id])) : []),
        [bundle, showOther, mapKey, state.players],
    );
    const gear = useMemo(() => (bundle ? loadout(bundle, state.players, mapKey) : null), [bundle, state.players, mapKey]);

    // ---------- прогресс ----------
    const setTaskStatus = useCallback(
        (playerId: string, taskId: string, s: TaskStatus | undefined) =>
            setState((st) => ({
                ...st,
                players: st.players.map((p) => {
                    if (p.id !== playerId) return p;
                    const tasks = { ...p.tasks };
                    if (s) tasks[taskId] = s;
                    else delete tasks[taskId];
                    return { ...p, tasks };
                }),
            })),
        [setState],
    );
    const setObjective = useCallback(
        (playerIds: string[], objectiveId: string, done: boolean | "toggle") =>
            setState((st) => ({
                ...st,
                players: st.players.map((p) => {
                    if (!playerIds.includes(p.id)) return p;
                    const d = { ...p.objectivesDone };
                    const v = done === "toggle" ? !d[objectiveId] : done;
                    if (v) d[objectiveId] = true;
                    else delete d[objectiveId];
                    return { ...p, objectivesDone: d };
                }),
            })),
        [setState],
    );
    const takeTask = useCallback(
        (taskId: string) => {
            const me = state.players.find((p) => p.id === state.activePlayer) ?? state.players[0];
            setTaskStatus(me.id, taskId, "active");
        },
        [state.players, state.activePlayer, setTaskStatus],
    );

    // ---------- сессия рейда ----------
    const isDone = useCallback(
        (s: RaidStep) =>
            s.stop.players.every((p) => {
                const live = state.players.find((x) => x.id === p.id);
                return !live || !!live.objectivesDone[s.stop.objective.id];
            }),
        [state.players],
    );
    const sessionOnMap = session && session.raid.steps[0] && plan ? session : undefined;
    const remaining = sessionOnMap ? sessionOnMap.raid.steps.filter((s) => !isDone(s) && !sessionOnMap.skipped.includes(s.stop.id)) : [];
    const target = remaining[0];
    const doneStops = useMemo(() => new Set((session?.raid.steps ?? plan.raids.flatMap((r) => r.steps)).filter(isDone).map((s) => s.stop.id)), [session, plan, isDone]);

    const startRaid = (i: number) => {
        const raid = plan.raids[i];
        if (!raid) return;
        setSession({ raid, startedAt: Date.now(), skipped: [] });
        setSel(i);
        setTab("nav");
    };
    const stopRaid = () => {
        setSession(undefined);
        pip?.close();
    };
    const markDone = () => target && setObjective(target.stop.players.map((p) => p.id), target.stop.objective.id, true);
    const skip = () => target && setSession((s) => (s ? { ...s, skipped: [...s.skipped, target.stop.id] } : s));

    useEffect(() => {
        if (!session) return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [session]);

    // ---------- папки игры ----------
    const setLink = (w: Which, l: NavLink) => setLinks((s) => ({ ...s, [w]: l }));

    useEffect(() => {
        (["shots", "logs"] as Which[]).forEach(async (w) => {
            const h = await loadHandle(w);
            if (!h) return;
            setHandles((s) => ({ ...s, [w]: h }));
            const ok = await ensurePermission(h, false);
            setLink(w, { status: ok ? "on" : "need-permission", name: h.name });
        });
    }, []);

    const connect = async (w: Which) => {
        try {
            let h = handles[w];
            if (h && links[w].status === "need-permission") {
                if (!(await ensurePermission(h, true))) return;
            } else {
                h = await pickDirectory(w === "shots" ? "eft-screenshots" : "eft-logs");
                await saveHandle(w, h);
            }
            setHandles((s) => ({ ...s, [w]: h }));
            setLink(w, { status: "on", name: h.name });
        } catch (e) {
            if ((e as Error).name !== "AbortError") setLink(w, { status: "error", error: (e as Error).message });
        }
    };
    const disconnect = async (w: Which) => {
        await saveHandle(w, undefined);
        setHandles((s) => ({ ...s, [w]: undefined }));
        setLink(w, { status: "off" });
    };

    useEffect(() => {
        const h = handles.shots;
        if (!h || links.shots.status !== "on") return;
        return watchScreenshots(
            h,
            (f) => setFix({ ...f, mapKey: mapKeyRef.current }),
            (e) => setLink("shots", { status: "error", name: h.name, error: e.message }),
        );
    }, [handles.shots, links.shots.status]);

    useEffect(() => {
        const h = handles.logs;
        if (!h || links.logs.status !== "on") return;
        return watchLogs(h, setLogState, (e) => setLink("logs", { status: "error", name: h.name, error: e.message }));
    }, [handles.logs, links.logs.status]);

    // ---------- квесты из логов ----------
    const [syncNote, setSyncNote] = useState<string>();
    const [historyProgress, setHistoryProgress] = useState<string>();
    const describeSync = (s: SyncSummary) =>
        [s.started && `взято ${s.started}`, s.finished && `выполнено ${s.finished}`, s.failed && `провалено ${s.failed}`, s.inferred && `по цепочкам +${s.inferred}`]
            .filter(Boolean)
            .join(", ");
    const applyEvents = useCallback(
        (events: LogState["taskEvents"], fromScratch: boolean) => {
            if (!bundle) return;
            setState((st) => {
                const me = st.players.find((p) => p.id === st.activePlayer) ?? st.players[0];
                const since = fromScratch ? 0 : st.logSync?.[st.mode] ?? 0;
                const r = applyTaskEvents(bundle, me, events, st.mode, since);
                const total = r.summary.started + r.summary.finished + r.summary.failed + r.summary.inferred;
                if (!total && r.last === since) return st;
                if (total) setSyncNote(`${me.name}: ${describeSync(r.summary)} (${new Date().toLocaleTimeString("ru-RU")})`);
                return { ...st, players: st.players.map((p) => (p.id === me.id ? r.player : p)), logSync: { ...st.logSync, [st.mode]: r.last } };
            });
        },
        [bundle, setState],
    );
    useEffect(() => {
        if (state.autoSync === false || !logState?.taskEvents.length) return;
        applyEvents(logState.taskEvents, false);
    }, [logState?.taskEvents, state.autoSync, applyEvents]);
    const syncHistory = async () => {
        const h = handles.logs;
        if (!h) return;
        try {
            const events = await scanTaskHistory(h, (d, t) => setHistoryProgress(`читаю логи: ${d} из ${t}`));
            setHistoryProgress(undefined);
            if (!events.length) {
                setSyncNote("В логах не нашлось событий квестов.");
                return;
            }
            applyEvents(events, true);
        } catch (e) {
            setHistoryProgress(undefined);
            setSyncNote("Ошибка чтения логов: " + (e as Error).message);
        }
    };
    const applyScanned = (playerId: string, ids: string[]) => {
        const p = state.players.find((x) => x.id === playerId);
        if (!bundle || !p) return "";
        const r = applyActiveList(bundle, p, ids);
        setState((st) => ({ ...st, players: st.players.map((x) => (x.id === playerId ? r.player : x)) }));
        return `${p.name}: активных ${ids.length} (новых ${r.added}), выполнено по цепочкам +${r.inferred}`;
    };

    // режим PvP/PvE — по логам
    useEffect(() => {
        const m = logState?.sessionMode;
        if (!autoMap || (m !== "pve" && m !== "regular")) return;
        setState((s) => (s.mode === m ? s : { ...s, mode: m }));
    }, [logState?.sessionMode, autoMap, setState]);

    // карта из логов
    useEffect(() => {
        if (!autoMap || !logState?.mapNameId || !bundle) return;
        const m = bundle.maps.find((x) => x.variants.some((v) => v.nameId.toLowerCase() === logState.mapNameId!.toLowerCase()));
        if (m && m.key !== mapKeyRef.current) setState((s) => ({ ...s, mapKey: m.key }));
    }, [logState?.mapNameId, autoMap, bundle, setState]);

    // ---------- окно поверх игры ----------
    const openPip = async () => {
        // Chrome/Edge: окно Picture-in-Picture всегда поверх остальных.
        // Если недоступно — обычное всплывающее окно (закрепить поверх: PowerToys, Win+Ctrl+T).
        let w: Window | null = null;
        try {
            w = (await window.documentPictureInPicture?.requestWindow({ width: 340, height: 620 })) ?? null;
        } catch {
            w = null;
        }
        if (!w) w = window.open("", "sherpa-hud", "popup,width=340,height=640");
        if (!w) {
            alert("Браузер заблокировал окно. Разреши всплывающие окна для этого сайта.");
            return;
        }
        w.document.head.innerHTML = "";
        for (const sheet of Array.from(document.styleSheets)) {
            try {
                const style = w.document.createElement("style");
                style.textContent = Array.from(sheet.cssRules).map((r) => r.cssText).join("\n");
                w.document.head.appendChild(style);
            } catch {
                if (sheet.href) {
                    const link = w.document.createElement("link");
                    link.rel = "stylesheet";
                    link.href = sheet.href;
                    w.document.head.appendChild(link);
                }
            }
        }
        w.document.title = "Sherpa · навигатор";
        w.document.body.className = "pip";
        w.addEventListener("pagehide", () => setPip(null));
        setPip(w);
    };

    const doFocus = (position: Vec3) => setFocus({ position, seq: Date.now() });
    const visibleFix = fix && fix.mapKey === mapKey ? fix : undefined;

    // Путь для навигатора: по общей сетке, а у цели (≤140 м) — подробный, через двери и лестницы.
    const [guide, setGuide] = useState<{ points: [number, number][]; length: number; detail?: DetailRoute }>();
    const goal = target?.point ?? session?.raid.extract?.position;
    useEffect(() => {
        if (!svc || !visibleFix || !goal || !gameMap) {
            setGuide(undefined);
            return;
        }
        let cancelled = false;
        (async () => {
            const ov = await svc.path(visibleFix.position, goal);
            let result: typeof guide = ov ?? undefined;
            if (gameMap.display.svgPath && straightDist(visibleFix.position, goal) < 140) {
                const text = await loadSvgText(gameMap.display.svgPath);
                const d = await detailRoute(gameMap, text, visibleFix.position, goal, ov?.points ?? null);
                if (d) result = { points: [...d.approach, ...d.segments.flatMap((sg) => sg.points)], length: d.length, detail: d };
            }
            if (!cancelled) setGuide(result);
        })().catch(() => !cancelled && setGuide(undefined));
        return () => {
            cancelled = true;
        };
    }, [svc, visibleFix, goal, gameMap]);

    // Подробный путь к выбранной цели в режиме планирования (клик по точке).
    const [detailSel, setDetailSel] = useState<{ raid: number; stopId: string }>();
    const [planDetail, setPlanDetail] = useState<{ stopId: string; route: DetailRoute | null; loading: boolean }>();
    useEffect(() => setDetailSel(undefined), [mapKey]);
    useEffect(() => {
        const raid = detailSel ? plan.raids[detailSel.raid] : undefined;
        const i = raid ? raid.steps.findIndex((st) => st.stop.id === detailSel!.stopId) : -1;
        if (!raid || i < 0 || !gameMap?.display.svgPath) {
            setPlanDetail(undefined);
            return;
        }
        const to = raid.steps[i].point;
        const from = i > 0 ? raid.steps[i - 1].point : raid.spawn ?? raid.extract?.position ?? to;
        // общий путь к этой точке — соответствующий отрезок рейда
        const legIdx = raid.spawn ? i : i - 1;
        const leg = raid.legs && legIdx >= 0 ? raid.legs[legIdx] : null;
        let cancelled = false;
        setPlanDetail({ stopId: detailSel!.stopId, route: null, loading: true });
        (async () => {
            const text = await loadSvgText(gameMap.display.svgPath!);
            let overview = leg;
            if (!overview && svc) overview = (await svc.path(from, to))?.points ?? null;
            const r = await detailRoute(gameMap, text, from, to, overview);
            if (!cancelled) setPlanDetail({ stopId: detailSel!.stopId, route: r, loading: false });
        })().catch(() => !cancelled && setPlanDetail({ stopId: detailSel!.stopId, route: null, loading: false }));
        return () => {
            cancelled = true;
        };
    }, [detailSel, plan, gameMap, svc]);
    const mapDetail = session ? guide?.detail : planDetail?.route ?? undefined;

    const hud =
        session && gameMap ? (
            <Hud
                map={gameMap}
                session={session}
                fix={visibleFix}
                now={now}
                target={target}
                remaining={remaining}
                extract={session.raid.extract}
                onDone={markDone}
                onSkip={skip}
                onStop={stopRaid}
                raidStartFromLog={logState?.raidStart}
                guide={guide}
            />
        ) : null;

    const mapPlan: RaidPlan = useMemo(() => (session ? { ...plan, raids: [{ ...session.raid, index: 0 }] } : plan), [session, plan]);

    return (
        <MarketContext.Provider value={marketCtx}>
        <div className="app">
            <header className="topbar">
                <div className="brand">
                    <span className="logo">SHERPA</span>
                    <span className="sub">квестовый проводник</span>
                </div>
                <div className="seg mode">
                    {(["regular", "pve"] as GameMode[]).map((m) => (
                        <button key={m} className={state.mode === m ? "on" : ""} onClick={() => setState({ ...state, mode: m })}>
                            {m === "regular" ? "PVP" : "PVE"}
                        </button>
                    ))}
                </div>
                <nav className="maps">
                    {bundle?.maps.map((m) => (
                        <button key={m.key} className={m.key === mapKey ? "on" : ""} onClick={() => setState({ ...state, mapKey: m.key })}>
                            {m.name}
                        </button>
                    ))}
                </nav>
            </header>

            {error && <div className="fatal">{error}</div>}
            {!bundle && !error && <div className="fatal">Загрузка данных…</div>}

            {bundle && gameMap && gear && (
                <div className="shell">
                    <main>
                        <MapView
                            bundle={bundle}
                            map={gameMap}
                            plan={mapPlan}
                            selectedRaid={session ? 0 : sel}
                            doneStops={doneStops}
                            targetStop={target?.stop.id}
                            otherTasks={otherTasks}
                            showOther={showOther}
                            showExtracts={showExtracts}
                            showLabels={showLabels}
                            fix={visibleFix}
                            guide={session && !guide?.detail ? guide?.points : undefined}
                            detail={mapDetail}
                            follow={follow && !!session}
                            onTakeTask={takeTask}
                            focus={focus}
                            onSelectStop={(stopId, raid) => {
                                if (!session) {
                                    setSel(raid);
                                    setDetailSel({ raid, stopId });
                                }
                                setTab(session ? "nav" : "raids");
                            }}
                        />
                        <div className="map-toggles">
                            <label className="check"><input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> районы</label>
                            <label className="check"><input type="checkbox" checked={showExtracts} onChange={(e) => setShowExtracts(e.target.checked)} /> выходы</label>
                            <label className="check"><input type="checkbox" checked={showOther} onChange={(e) => setShowOther(e.target.checked)} /> невзятые квесты</label>
                        </div>
                        {hud && !pip && <div className="hud-float">{hud}</div>}
                    </main>
                    <aside>
                        <div className="tabs">
                            {(
                                [
                                    ["quests", "Квесты"],
                                    ["raids", `Рейды${plan.raids.length ? ` ${plan.raids.length}` : ""}`],
                                    ["loadout", "Снаряжение"],
                                    ["market", "Барахолка"],
                                    ["nav", session ? "● Навигатор" : "Навигатор"],
                                    ["players", "Группа"],
                                ] as [Tab, string][]
                            ).map(([k, label]) => (
                                <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                                    {label}
                                </button>
                            ))}
                        </div>
                        <div className="tab-scroll">
                            {tab === "quests" && (
                                <QuestsTab
                                    bundle={bundle}
                                    players={state.players}
                                    mapKey={mapKey}
                                    mapName={gameMap.name}
                                    setTaskStatus={setTaskStatus}
                                    toggleObjective={(pid, oid) => setObjective([pid], oid, "toggle")}
                                    onFocus={doFocus}
                                    scan={<QuestScan bundle={bundle} players={state.players} activePlayer={state.activePlayer} shotsDir={links.shots.status === "on" ? handles.shots : undefined} onApply={applyScanned} />}
                                />
                            )}
                            {tab === "raids" && (
                                <RaidsTab
                                    bundle={bundle}
                                    map={gameMap}
                                    plan={plan}
                                    players={state.players}
                                    settings={raidSettings}
                                    setSettings={(s) => setState((st) => ({ ...st, raidSettings: s }))}
                                    selected={sel}
                                    setSelected={setSel}
                                    extractOverride={extractOverride[mapKey] ?? {}}
                                    setExtractOverride={(o) => setExtractOverride((all) => ({ ...all, [mapKey]: o }))}
                                    includeShoot={includeShoot}
                                    setIncludeShoot={setIncludeShoot}
                                    sideTasks={sideTasks}
                                    onStart={startRaid}
                                    onFocusStop={(id, r) => {
                                        setSel(r);
                                        setDetailSel(detailSel?.stopId === id ? undefined : { raid: r, stopId: id });
                                        const st = plan.raids[r]?.steps.find((s) => s.stop.id === id);
                                        if (st) doFocus(st.point);
                                    }}
                                    sessionRaid={session?.raid.name}
                                    routesState={routesState}
                                    detail={planDetail}
                                />
                            )}
                            {tab === "loadout" && <LoadoutTab bundle={bundle} loadout={gear} mapName={gameMap.name} />}
                            {tab === "market" && (
                                <MarketTab
                                    mode={state.mode}
                                    onRefresh={async () => {
                                        if (market) setMarket(await refreshMarket(market));
                                    }}
                                    setIntel={(b) => setState((st) => ({ ...st, intelCenter: b }))}
                                    shotsDir={links.shots.status === "on" ? handles.shots : undefined}
                                />
                            )}
                            {tab === "nav" && (
                                <>
                                    {hud && pip && <div className="hud-inline">{hud}</div>}
                                    <NavigatorTab
                                        shots={links.shots}
                                        logs={links.logs}
                                        connectShots={() => connect("shots")}
                                        connectLogs={() => connect("logs")}
                                        disconnect={disconnect}
                                        fix={fix}
                                        log={logState}
                                        follow={follow}
                                        setFollow={setFollow}
                                        autoMap={autoMap}
                                        setAutoMap={setAutoMap}
                                        pipOpen={!!pip}
                                        openPip={openPip}
                                        pipSupported={true}
                                        sessionActive={!!session}
                                        meName={(state.players.find((x) => x.id === state.activePlayer) ?? state.players[0]).name}
                                        autoSync={state.autoSync !== false}
                                        setAutoSync={(b) => setState((st) => ({ ...st, autoSync: b }))}
                                        onSyncHistory={syncHistory}
                                        syncNote={syncNote}
                                        historyProgress={historyProgress}
                                    />
                                </>
                            )}
                            {tab === "players" && <PlayersTab state={state} setState={setState} />}
                        </div>
                        <footer>
                            Данные <a href="https://tarkov.dev" target="_blank" rel="noreferrer">tarkov.dev</a> от {new Date(bundle.generatedAt).toLocaleDateString("ru-RU")} · карты{" "}
                            <a href="https://github.com/the-hideout/tarkov-dev-svg-maps" target="_blank" rel="noreferrer">tarkov-dev-svg-maps</a> (CC BY-NC-SA 4.0)
                        </footer>
                    </aside>
                </div>
            )}
            {pip && hud && createPortal(hud, pip.document.body)}
            <PriceTip tip={tip} />
        </div>
        </MarketContext.Provider>
    );
}
