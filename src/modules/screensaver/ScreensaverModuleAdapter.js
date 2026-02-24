"use strict";

(function initScreensaverModuleAdapter(globalScope) {
    const DEFAULTS = Object.freeze({
        canvasWidth: 640,
        canvasHeight: 360,
        logoSvgUrl: "./src/modules/screensaver/color-icon.svg",
        speedPxPerSec: 170
    });

    class ScreensaverModuleAdapter {
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
            if (!globalScope.JigsawScreensaverRuntimeAdapter) {
                throw new Error("JigsawScreensaverRuntimeAdapter is not available");
            }
            this.runtime = new globalScope.JigsawScreensaverRuntimeAdapter(Object.assign({}, this.options));
            return this.runtime;
        }

        start(payload) {
            const runtime = this._ensureRuntime();
            return runtime.start(payload || null);
        }

        stop(reason = "manual") {
            const runtime = this._ensureRuntime();
            return runtime.stop(reason);
        }

        isRunning() {
            const runtime = this._ensureRuntime();
            return !!(runtime.isRunning && runtime.isRunning());
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
            if (!event) return false;
            if (type === "up") return false;
            if (String(event.code || "") !== "Escape") return false;
            if (this.context && typeof this.context.requestStop === "function") {
                this.context.requestStop({ reason: "manual", moduleId: "screensaver" }).catch(() => {});
            }
            return true;
        }
    }

    globalScope.JigsawScreensaverModuleAdapter = ScreensaverModuleAdapter;
})(window);
