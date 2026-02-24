"use strict";

(function initSecretCodeMatcher(globalScope) {
    class SecretCodeMatcher {
        constructor(options = {}) {
            this.timeoutMs = Math.max(250, Number(options.timeoutMs) || 3000);
            this._entries = [];
            this._states = new Map();
            this._timers = new Map();
        }

        setEntries(entries) {
            this._entries = Array.isArray(entries) ? entries.slice() : [];
            this._states.clear();
            this._clearAllTimers();
            for (const entry of this._entries) {
                this._states.set(entry.id, 0);
            }
        }

        _clearAllTimers() {
            this._timers.forEach((timer) => {
                try { globalScope.clearTimeout(timer); } catch (_e) {}
            });
            this._timers.clear();
        }

        _scheduleReset(moduleId) {
            const id = String(moduleId || "");
            if (!id) return;
            const existing = this._timers.get(id);
            if (existing) {
                try { globalScope.clearTimeout(existing); } catch (_e) {}
            }
            const timer = globalScope.setTimeout(() => {
                this._timers.delete(id);
                this._states.set(id, 0);
            }, this.timeoutMs);
            this._timers.set(id, timer);
        }

        resetAll() {
            this._clearAllTimers();
            for (const entry of this._entries) {
                this._states.set(entry.id, 0);
            }
        }

        processEvent(event) {
            if (!event) return null;
            if (event.ctrlKey || event.metaKey || event.altKey) {
                this.resetAll();
                return null;
            }
            const key = (typeof event.key === "string" && event.key.length === 1)
                ? event.key.toLowerCase()
                : "";
            if (!key) {
                this.resetAll();
                return null;
            }
            for (const entry of this._entries) {
                const secret = String(entry.secretCode || "");
                if (!secret) continue;
                const current = Number(this._states.get(entry.id) || 0);
                const expected = secret.charAt(current);
                let nextIndex = 0;
                if (key === expected) nextIndex = current + 1;
                else nextIndex = key === secret.charAt(0) ? 1 : 0;
                this._states.set(entry.id, nextIndex);
                if (nextIndex >= secret.length) {
                    this.resetAll();
                    return entry;
                }
                if (nextIndex > 0) this._scheduleReset(entry.id);
            }
            return null;
        }
    }

    globalScope.JigsawSecretCodeMatcher = SecretCodeMatcher;
})(window);

