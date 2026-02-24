"use strict";

(function initModuleScriptLoader(globalScope) {
    class ModuleScriptLoader {
        constructor(options = {}) {
            this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || 30000);
            this._cache = new Map();
        }

        _waitWithTimeout(promise, timeoutMs, message) {
            const ms = Math.max(1, Number(timeoutMs || this.timeoutMs) | 0);
            return new Promise((resolve, reject) => {
                const timer = globalScope.setTimeout(() => reject(new Error(message || "script load timed out")), ms);
                Promise.resolve(promise).then((value) => {
                    globalScope.clearTimeout(timer);
                    resolve(value);
                }).catch((error) => {
                    globalScope.clearTimeout(timer);
                    reject(error);
                });
            });
        }

        async loadScript(url) {
            const key = String(url || "").trim();
            if (!key) return false;
            if (this._cache.has(key)) return this._cache.get(key);
            const promise = this._waitWithTimeout(new Promise((resolve, reject) => {
                const existing = document.querySelector(`script[data-jigsaw-runtime-src="${CSS.escape(key)}"]`);
                if (existing && existing.getAttribute("data-jigsaw-runtime-loaded") === "1") {
                    resolve(true);
                    return;
                }
                if (existing) {
                    existing.addEventListener("load", () => resolve(true), { once: true });
                    existing.addEventListener("error", () => reject(new Error("failed to load runtime script: " + key)), { once: true });
                    return;
                }
                const script = document.createElement("script");
                script.src = key;
                script.async = true;
                script.crossOrigin = "anonymous";
                script.setAttribute("data-jigsaw-runtime-src", key);
                script.addEventListener("load", () => {
                    script.setAttribute("data-jigsaw-runtime-loaded", "1");
                    resolve(true);
                }, { once: true });
                script.addEventListener("error", () => reject(new Error("failed to load runtime script: " + key)), { once: true });
                document.head.appendChild(script);
            }), this.timeoutMs, "runtime script timed out: " + key);
            this._cache.set(key, promise);
            try {
                return await promise;
            } catch (error) {
                this._cache.delete(key);
                throw error;
            }
        }

        async loadAll(urls) {
            const list = Array.isArray(urls) ? urls : [];
            for (const url of list) {
                await this.loadScript(url);
            }
            return true;
        }
    }

    globalScope.JigsawModuleScriptLoader = ModuleScriptLoader;
})(window);

