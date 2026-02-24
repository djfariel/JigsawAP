"use strict";

(function initModuleKeyRouter(globalScope) {
    class ModuleKeyRouter {
        constructor(options = {}) {
            this.logger = typeof options.logger === "function" ? options.logger : () => {};
            this._activeEntry = null;
            this._activeAdapter = null;
        }

        setActiveModule(entry, adapter) {
            this._activeEntry = entry || null;
            this._activeAdapter = adapter || null;
        }

        clearActiveModule() {
            this._activeEntry = null;
            this._activeAdapter = null;
        }

        hasHooks() {
            if (!this._activeEntry || !this._activeAdapter) return false;
            if (this._activeAdapter.isRunning && this._activeAdapter.isRunning()) return true;
            if (this._activeAdapter.canResume && this._activeAdapter.canResume()) return true;
            return false;
        }

        _isFunctionKeyEvent(event) {
            const code = String((event && event.code) || "");
            const key = String((event && event.key) || "");
            return /^F\d{1,2}$/i.test(code) || /^F\d{1,2}$/i.test(key);
        }

        _isStandaloneModifier(event) {
            const code = String((event && event.code) || "");
            const key = String((event && event.key) || "");
            return (
                code === "ControlLeft" || code === "ControlRight" || code === "Control" ||
                code === "AltLeft" || code === "AltRight" || code === "Alt" ||
                code === "ShiftLeft" || code === "ShiftRight" || code === "Shift" ||
                key === "Control" || key === "Alt" || key === "Shift"
            );
        }

        shouldConsumeFunctionKey(event) {
            if (!this.hasHooks()) return false;
            if (!this._activeEntry || !this._activeEntry.keySubscriptions) return false;
            if (!this._activeEntry.keySubscriptions.blockFunctionKeys) return false;
            return this._isFunctionKeyEvent(event);
        }

        route(event, type) {
            if (!event || !this.hasHooks()) return false;
            const entry = this._activeEntry;
            const adapter = this._activeAdapter;
            if (!entry || !adapter) return false;
            const cfg = entry.keySubscriptions || {};
            if (event.isTrusted === false) return false;
            if (!cfg.allowMeta && event.metaKey) return false;
            if (!cfg.allowCtrlAlt && (event.ctrlKey || event.altKey) && !this._isStandaloneModifier(event)) return false;
            if (this._isFunctionKeyEvent(event)) return false;
            const code = String(event.code || "");
            if (Array.isArray(cfg.forwardCodes) && cfg.forwardCodes.length > 0) {
                if (!cfg.forwardCodes.includes(code)) return false;
            }

            const handler = typeof adapter.onKeyEvent === "function"
                ? adapter.onKeyEvent.bind(adapter)
                : (typeof adapter.sendKeyEvent === "function" ? adapter.sendKeyEvent.bind(adapter) : null);
            if (!handler) return false;
            const ok = !!handler(event, type === "up" ? "up" : "down");
            if (!ok) return false;

            if (cfg.stopPropagation !== false) {
                if (typeof event.stopPropagation === "function") event.stopPropagation();
                if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
            }
            if (cfg.preventDefault !== false && event.cancelable) {
                event.preventDefault();
            }
            return true;
        }
    }

    globalScope.JigsawModuleKeyRouter = ModuleKeyRouter;
})(window);

