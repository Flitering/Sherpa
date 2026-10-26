// Мост между интерфейсом и основным процессом: только перечисленные функции.
const { contextBridge, ipcRenderer } = require("electron");

const on = (channel) => (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld("sherpa", {
    platform: process.platform,
    win: {
        minimize: () => ipcRenderer.invoke("win:minimize"),
        toggleMaximize: () => ipcRenderer.invoke("win:toggleMaximize"),
        close: () => ipcRenderer.invoke("win:close"),
        isMaximized: () => ipcRenderer.invoke("win:isMaximized"),
        onState: on("win:state"),
    },
    app: {
        info: () => ipcRenderer.invoke("app:info"),
        openExternal: (url) => ipcRenderer.invoke("shell:open", url),
        showFolder: (p) => ipcRenderer.invoke("shell:showFolder", p),
        prefs: () => ipcRenderer.invoke("app:prefs"),
        setPrefs: (patch) => ipcRenderer.invoke("app:setPrefs", patch),
    },
    hotkeys: {
        get: () => ipcRenderer.invoke("hotkeys:get"),
        set: (id, acc) => ipcRenderer.invoke("hotkeys:set", id, acc),
        pause: (on) => ipcRenderer.invoke("hotkeys:pause", on),
        onState: on("hotkeys:state"),
    },
    store: {
        load: () => ipcRenderer.invoke("store:load"),
        save: (json) => ipcRenderer.invoke("store:save", json),
    },
    price: {
        get: () => ipcRenderer.invoke("price:get"),
        set: (patch) => ipcRenderer.invoke("price:set", patch),
        onState: on("price:state"),
        openDebug: () => ipcRenderer.invoke("price:openDebug"),
        showTest: () => ipcRenderer.invoke("price:showTest"),
        onPreview: on("price:preview"),
        onScan: on("price:scan"),
        result: (r) => ipcRenderer.send("price:result", r),
        debug: (d) => ipcRenderer.send("price:debug", d),
    },
    update: {
        get: () => ipcRenderer.invoke("update:get"),
        check: () => ipcRenderer.invoke("update:check"),
        download: () => ipcRenderer.invoke("update:download"),
        install: () => ipcRenderer.invoke("update:install"),
        onState: on("update:state"),
    },
    paths: {
        get: () => ipcRenderer.invoke("paths:get"),
        pick: (kind) => ipcRenderer.invoke("paths:pick", kind),
        reset: (kind) => ipcRenderer.invoke("paths:reset", kind),
        screenshotKey: () => ipcRenderer.invoke("game:screenshotKey"),
    },
    fs: {
        list: (dir) => ipcRenderer.invoke("fs:list", dir),
        stat: (file) => ipcRenderer.invoke("fs:stat", file),
        readText: (file, start, end) => ipcRenderer.invoke("fs:readText", file, start, end),
        readBytes: (file) => ipcRenderer.invoke("fs:readBytes", file),
    },
    overlay: {
        open: () => ipcRenderer.invoke("overlay:open"),
        close: () => ipcRenderer.invoke("overlay:close"),
        set: (patch) => ipcRenderer.invoke("overlay:set", patch),
        getState: () => ipcRenderer.invoke("overlay:getState"),
        update: (model) => ipcRenderer.send("overlay:model", model),
        action: (a) => ipcRenderer.send("overlay:action", a),
        hoverHandle: (on) => ipcRenderer.send("overlay:hoverHandle", on),
        onModel: on("overlay:model"),
        onState: on("overlay:state"),
        onAction: on("overlay:action"),
        onClosed: on("overlay:closed"),
    },
    data: {
        sync: (modes) => ipcRenderer.invoke("data:sync", modes),
        info: () => ipcRenderer.invoke("data:info"),
        onProgress: on("data:progress"),
    },
    tarkovMarket: {
        info: () => ipcRenderer.invoke("tm:info"),
        setKey: (key) => ipcRenderer.invoke("tm:set", key),
    },
});
