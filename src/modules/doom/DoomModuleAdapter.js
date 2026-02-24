"use strict";

/**
 * DOOM runtime module adapter.
 *
 * Module-specific defaults live at the top so module authors can tweak
 * behavior without touching host integration files.
 */
(function initDoomModuleAdapter(globalScope) {
    const DEFAULTS = Object.freeze({
        loaderUrl: "",
        wasmUrl: "",
        factoryName: "createDoomGenericModule",
        canvasWidth: 320,
        canvasHeight: 200,
        launchArgs: []
    });

    class DoomModuleAdapter {
        constructor(options = {}) {
            this.options = Object.assign({}, DEFAULTS, options || {});
            this.context = null;
            this.runtime = null;
        }

        init(context) {
            this.context = context || null;
        }

        _ensureRuntime() {
            if (this.runtime) return this.runtime;
            if (!globalScope.JigsawDoomRuntimeAdapter) {
                throw new Error("JigsawDoomRuntimeAdapter is not available");
            }
            this.runtime = new globalScope.JigsawDoomRuntimeAdapter(Object.assign({}, this.options, {
                onStatus: (status) => {
                    if (!status || !status.message) return;
                    const level = status.level === "error" ? "error" : "info";
                    if (this.context && typeof this.context.logger === "function") {
                        this.context.logger("[DOOM] " + status.message, level);
                    } else if (level === "error") {
                        console.error("[DOOM]", status.message);
                    } else {
                        console.log("[DOOM]", status.message);
                    }
                },
                onExit: async (_payload) => {
                    if (this.context && typeof this.context.requestStop === "function") {
                        try {
                            await this.context.requestStop({ reason: "runtime-exit", moduleId: "doom" });
                        } catch (_e) {}
                    }
                }
            }));
            return this.runtime;
        }

        async start(payload) {
            const runtime = this._ensureRuntime();
            return runtime.start(payload || null);
        }

        async validateStartPayload(payload) {
            const runtime = this._ensureRuntime();
            if (!runtime.validateStartPayload) {
                return { ok: true, errors: [], warnings: [] };
            }
            return await runtime.validateStartPayload(payload || null);
        }

        async stop(reason = "manual") {
            const runtime = this._ensureRuntime();
            return runtime.stop(reason);
        }

        isRunning() {
            const runtime = this._ensureRuntime();
            return !!(runtime.isRunning && runtime.isRunning());
        }

        canResume() {
            const runtime = this._ensureRuntime();
            return !!(runtime.canResume && runtime.canResume());
        }

        getFrameSource() {
            const runtime = this._ensureRuntime();
            return runtime.getFrameSource ? runtime.getFrameSource() : null;
        }

        updateFrameClock(nowMs) {
            const runtime = this._ensureRuntime();
            return !!(runtime.updateFrameClock && runtime.updateFrameClock(nowMs));
        }

        onKeyEvent(event, type = "down") {
            const runtime = this._ensureRuntime();
            if (!runtime.sendKeyEvent) return false;
            return !!runtime.sendKeyEvent(event, type === "up" ? "up" : "down");
        }
    }

    globalScope.JigsawDoomModuleAdapter = DoomModuleAdapter;
})(window);

