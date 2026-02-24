"use strict";

(function initModuleOrchestrator(globalScope) {
    class ModuleOrchestrator {
        constructor(options = {}) {
            this.registry = options.registry || new globalScope.JigsawModuleRegistry();
            this.scriptLoader = options.scriptLoader || new globalScope.JigsawModuleScriptLoader();
            this.secretMatcher = options.secretMatcher || new globalScope.JigsawSecretCodeMatcher();
            this.keyRouter = options.keyRouter || new globalScope.JigsawModuleKeyRouter();
            this.logger = typeof options.logger === "function" ? options.logger : () => {};
            this.getRendererFacade = typeof options.getRendererFacade === "function" ? options.getRendererFacade : () => null;
            this.getMediaBindings = typeof options.getMediaBindings === "function" ? options.getMediaBindings : () => null;
            this.getImagePath = typeof options.getImagePath === "function" ? options.getImagePath : () => "";
            this.setImagePath = typeof options.setImagePath === "function" ? options.setImagePath : () => {};
            this.getPuzzle = typeof options.getPuzzle === "function" ? options.getPuzzle : () => null;
            this.getStopButton = typeof options.getStopButton === "function" ? options.getStopButton : () => null;
            this.requestFile = typeof options.requestFile === "function" ? options.requestFile : async () => null;
            this.requestActivationFiles = typeof options.requestActivationFiles === "function"
                ? options.requestActivationFiles
                : async (payload) => {
                    const files = payload && Array.isArray(payload.files) ? payload.files : [];
                    const out = {};
                    for (let i = 0; i < files.length; i++) {
                        const slot = files[i] || {};
                        const role = String(slot.role || slot.id || ("file" + (i + 1))).trim();
                        if (!role) continue;
                        const selected = await this.requestFile(slot);
                        if (!selected && slot.required !== false) return null;
                        if (selected) out[role] = selected;
                    }
                    return out;
                };
            this.isTextInputFocused = typeof options.isTextInputFocused === "function" ? options.isTextInputFocused : () => false;
            this.isGameplayStarted = typeof options.isGameplayStarted === "function" ? options.isGameplayStarted : () => false;
            this._activeEntry = null;
            this._activeAdapter = null;
            this._activationInFlight = false;
            this._stopInFlight = false;
            this._restoreMediaHint = null;
            this._adapterById = new Map();
        }

        registerAll(manifestEntries) {
            const entries = this.registry.registerAll(manifestEntries);
            this.secretMatcher.setEntries(entries);
            this.refreshStopButton();
            return entries;
        }

        _buildContext() {
            return {
                rendererFacade: this.getRendererFacade(),
                mediaBindings: this.getMediaBindings(),
                ui: {
                    refreshStopButton: () => this.refreshStopButton()
                },
                logger: (message, level = "info") => this.logger(message, level),
                requestFile: async (opts) => this.requestFile(opts || null),
                requestActivationFiles: async (opts) => this.requestActivationFiles(opts || {}),
                requestStop: async (payload = {}) => {
                    const reason = payload && payload.reason ? payload.reason : "runtime-exit";
                    await this.stopActive(reason);
                }
            };
        }

        async _collectActivationFiles(entry, adapter = null) {
            if (!entry || !entry.activation || !entry.activation.requiresFile) return null;
            const activation = entry.activation || {};
            const files = Array.isArray(activation.files) ? activation.files : [];
            if (files.length > 0) {
                const selectedMap = await this.requestActivationFiles({
                    moduleId: entry.id,
                    moduleLabel: entry.label,
                    files: files,
                    validateSelection: async (payload) => {
                        if (!adapter || typeof adapter.validateStartPayload !== "function") {
                            return { ok: true, errors: [], warnings: [] };
                        }
                        return await adapter.validateStartPayload(payload || null);
                    }
                });
                if (!selectedMap) return false;
                return selectedMap;
            }
            const promptList = Array.isArray(activation.filePrompts) ? activation.filePrompts : [];
            if (promptList.length > 0) {
                const payload = {};
                for (let i = 0; i < promptList.length; i++) {
                    const prompt = promptList[i] || {};
                    const role = String(prompt.role || ("file" + (i + 1))).trim();
                    if (!role) continue;
                    const required = prompt.required !== false;
                    const selectedFile = await this.requestFile(prompt);
                    if (!selectedFile && required) return false;
                    if (selectedFile) payload[role] = selectedFile;
                }
                return payload;
            }
            const selectedFile = await this.requestFile(activation.filePrompt || null);
            if (!selectedFile) return false;
            return { file: selectedFile };
        }

        _getAdapterForEntry(entry) {
            if (!entry) throw new Error("Missing module entry");
            if (this._adapterById.has(entry.id)) return this._adapterById.get(entry.id);
            const Ctor = globalScope[entry.adapterGlobal];
            if (typeof Ctor !== "function") {
                throw new Error(`Module adapter '${entry.adapterGlobal}' is not available`);
            }
            const adapter = new Ctor(Object.assign({}, entry.config || {}));
            if (adapter && typeof adapter.init === "function") {
                adapter.init(this._buildContext());
            }
            this._adapterById.set(entry.id, adapter);
            return adapter;
        }

        getActiveEntry() {
            return this._activeEntry;
        }

        isModuleActive() {
            const renderer = this.getRendererFacade();
            const rendererActive = !!(renderer && renderer.isModuleActive && renderer.isModuleActive());
            const runtimeActive = !!(this._activeAdapter && this._activeAdapter.isRunning && this._activeAdapter.isRunning());
            return rendererActive && runtimeActive;
        }

        hasKeyboardHooks() {
            return this.keyRouter.hasHooks();
        }

        shouldConsumeFunctionKey(event) {
            return this.keyRouter.shouldConsumeFunctionKey(event);
        }

        routeKeyEvent(event, type) {
            if (this.isTextInputFocused()) return false;
            return this.keyRouter.route(event, type);
        }

        async _activateEntry(entry) {
            if (!entry) return false;
            await this.scriptLoader.loadAll(entry.scriptUrls || []);
            const adapter = this._getAdapterForEntry(entry);

            if (this._activeEntry && this._activeEntry.id !== entry.id) {
                await this.stopActive("switch");
            }

            let startPayload = null;
            if (entry.activation && entry.activation.requiresFile) {
                startPayload = await this._collectActivationFiles(entry, adapter);
                if (startPayload === false) return false;
                if (adapter && typeof adapter.validateStartPayload === "function") {
                    const report = await adapter.validateStartPayload(startPayload || null);
                    if (report && Array.isArray(report.errors) && report.errors.length > 0) {
                        throw new Error(report.errors.join("\n"));
                    }
                    if (report && Array.isArray(report.warnings) && report.warnings.length > 0) {
                        for (const warning of report.warnings) {
                            this.logger("[MODULE WARNING] " + String(warning), "warn");
                        }
                    }
                }
            }

            this._restoreMediaHint = { imagePath: this.getImagePath() || "", timestamp: Date.now() };
            await adapter.start(startPayload || null);

            const renderer = this.getRendererFacade();
            if (!renderer || !renderer.setModuleSource) throw new Error("Renderer facade is unavailable");
            const ok = renderer.setModuleSource(adapter, adapter.getFrameSource ? adapter.getFrameSource() : null);
            if (!ok) throw new Error(`Failed to bind module source (${entry.id})`);

            this._activeEntry = entry;
            this._activeAdapter = adapter;
            this.keyRouter.setActiveModule(entry, adapter);
            this.refreshStopButton();
            return true;
        }

        async activateBySecretCodeEvent(event) {
            if (this._activationInFlight) return false;
            if (!this.isGameplayStarted()) {
                this.secretMatcher.resetAll();
                return false;
            }
            if (!event) return false;
            const matched = this.secretMatcher.processEvent(event);
            if (!matched) return false;
            this._activationInFlight = true;
            try {
                if (event.cancelable) event.preventDefault();
                return await this._activateEntry(matched);
            } finally {
                this._activationInFlight = false;
            }
        }

        async stopActive(reason = "manual") {
            if (this._stopInFlight) return;
            this._stopInFlight = true;
            try {
                const renderer = this.getRendererFacade();
                const adapter = this._activeAdapter;
                if (renderer && renderer.clearModuleSource) {
                    renderer.clearModuleSource(true);
                }
                if (adapter && typeof adapter.stop === "function") {
                    await adapter.stop(reason);
                }
                const frameSource = (renderer && renderer.media && renderer.media.getFrameSource)
                    ? renderer.media.getFrameSource()
                    : null;
                const restorePath = (this._restoreMediaHint && this._restoreMediaHint.imagePath)
                    ? this._restoreMediaHint.imagePath
                    : this.getImagePath();
                if (!frameSource && restorePath) {
                    try {
                        this.setImagePath(restorePath, { forceMediaKind: "image", preserveVideo: false });
                    } catch (_e) {}
                }
                // Static sources do not naturally trigger a new media frame tick after
                // module stop, so force one immediate restore draw when possible.
                const puzzle = this.getPuzzle ? this.getPuzzle() : null;
                if (frameSource && puzzle && typeof puzzle.applyMediaFrame === "function") {
                    try {
                        const nowMs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
                        puzzle.applyMediaFrame(frameSource, nowMs);
                    } catch (_e) {}
                }
                if (renderer && renderer.sceneState && renderer.sceneState.markAllDirty) renderer.sceneState.markAllDirty();
                if (renderer && renderer.renderDirtyPieces) renderer.renderDirtyPieces();
                this._activeEntry = null;
                this._activeAdapter = null;
                this._restoreMediaHint = null;
                this.keyRouter.clearActiveModule();
                if (reason) this.logger("module mode stopped: " + reason, "info");
                this.refreshStopButton();
            } finally {
                this._stopInFlight = false;
            }
        }

        refreshStopButton() {
            const btn = this.getStopButton();
            if (!btn) return;
            const active = this.isModuleActive();
            btn.style.display = active ? "inline-block" : "none";
            if (active && this._activeEntry) {
                btn.textContent = this._activeEntry.stopButtonLabel || ("Stop " + this._activeEntry.label);
                btn.title = "Stop " + this._activeEntry.label + " mode and restore previous puzzle media";
            } else {
                btn.textContent = "Stop Module";
                btn.title = "Stop active module mode and restore previous puzzle media";
            }
        }
    }

    globalScope.JigsawModuleOrchestrator = ModuleOrchestrator;
})(window);

