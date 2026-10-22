import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
    plugins: [react()],
    base: "./",
    // Dev-сервер слушает только этот компьютер.
    server: { host: "127.0.0.1", port: 5173, strictPort: true },
    preview: { host: "127.0.0.1", port: 4173 },
    build: {
        // три страницы: главное окно, виджет поверх игры и карточка цены
        rollupOptions: { input: { index: resolve(__dirname, "index.html"), overlay: resolve(__dirname, "overlay.html"), price: resolve(__dirname, "price.html") } },
    },
});
