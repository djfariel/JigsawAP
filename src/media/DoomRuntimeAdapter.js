"use strict";

(function initDoomRuntimeAdapter(globalScope) {
    class DoomRuntimeAdapter {
        constructor(options = {}) {
            this.loaderUrl = options.loaderUrl || "";
            this.wasmUrl = options.wasmUrl || "";
            this.factoryName = options.factoryName || "createDoomGenericModule";
            this.canvasWidth = options.canvasWidth || 320;
            this.canvasHeight = options.canvasHeight || 200;
            this.launchArgs = Array.isArray(options.launchArgs) ? options.launchArgs.slice() : [];
            this.onStatus = typeof options.onStatus === "function" ? options.onStatus : null;
            this.module = null;
            this.outputCanvas = null;
            this.running = false;
            this.lastError = "";
            this.frameVersion = 0;
            this.lastFrameVersionDelivered = 0;
            this._rafHandle = 0;
            this._loaderPromise = null;
            this._mountedWadPath = "";
            this._moduleKind = "";
            this._runtimeReadyResolve = null;
            this.loaderTimeoutMs = Math.max(1000, Number(options.loaderTimeoutMs) || 20000);
            this.runtimeTimeoutMs = Math.max(1000, Number(options.runtimeTimeoutMs) || 30000);
            this.lastWadInfo = null;
        }

        _emitStatus(message, level = "info") {
            if (!this.onStatus) return;
            try {
                this.onStatus({ message: String(message || ""), level: level || "info" });
            } catch (_e) {}
        }

        _createCanvas() {
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, this.canvasWidth | 0);
            canvas.height = Math.max(1, this.canvasHeight | 0);
            canvas.id = "canvas";
            canvas.style.position = "fixed";
            canvas.style.left = "-10000px";
            canvas.style.top = "-10000px";
            canvas.style.width = "1px";
            canvas.style.height = "1px";
            canvas.style.opacity = "0";
            canvas.style.pointerEvents = "none";
            return canvas;
        }

        _ensureCanvasAttached(canvas) {
            if (!canvas) return;
            const existing = document.getElementById("canvas");
            if (existing && existing !== canvas) {
                existing.id = "canvas_prev_" + Date.now();
            }
            canvas.id = "canvas";
            if (!canvas.parentNode) {
                document.body.appendChild(canvas);
            }
        }

        _seedGlobalModuleForNonModularizedBuild(moduleOptions) {
            const existing = (globalScope.Module && typeof globalScope.Module === "object") ? globalScope.Module : {};
            const prevOnRuntimeInitialized = existing.onRuntimeInitialized;
            const nextOnRuntimeInitialized = moduleOptions && moduleOptions.onRuntimeInitialized
                ? moduleOptions.onRuntimeInitialized
                : null;
            const merged = Object.assign(existing, moduleOptions || {});
            if (typeof prevOnRuntimeInitialized === "function" || typeof nextOnRuntimeInitialized === "function") {
                merged.onRuntimeInitialized = () => {
                    if (typeof prevOnRuntimeInitialized === "function") {
                        try { prevOnRuntimeInitialized(); } catch (_e) {}
                    }
                    if (typeof nextOnRuntimeInitialized === "function") {
                        try { nextOnRuntimeInitialized(); } catch (_e) {}
                    }
                };
            }
            globalScope.Module = merged;
        }

        async _ensureRuntimeLoader(moduleOptions = null) {
            if (typeof globalScope[this.factoryName] === "function") {
                this._moduleKind = "factory";
                return;
            }
            if (globalScope.Module && globalScope.Module.FS && globalScope.Module.callMain) {
                this._moduleKind = "global";
                return;
            }
            if (!this.loaderUrl) {
                throw new Error("doom loader url is missing");
            }
            if (!this._loaderPromise) {
                // Non-modularized Emscripten builds read Module settings while evaluating the loader script.
                // Seed the object before script injection so canvas/locateFile are in place in time.
                this._seedGlobalModuleForNonModularizedBuild(moduleOptions || null);
                this._loaderPromise = new Promise((resolve, reject) => {
                    const script = document.createElement("script");
                    script.src = this.loaderUrl;
                    script.async = true;
                    script.crossOrigin = "anonymous";
                    script.onload = () => resolve();
                    script.onerror = () => reject(new Error("failed to load doom runtime loader"));
                    document.head.appendChild(script);
                });
            }
            this._emitStatus("Loading DOOM runtime loader...");
            await this._waitWithTimeout(this._loaderPromise, this.loaderTimeoutMs, "doom loader timed out");
            if (typeof globalScope[this.factoryName] === "function") {
                this._moduleKind = "factory";
                return;
            }
            if (globalScope.Module && globalScope.Module.FS && globalScope.Module.callMain) {
                this._moduleKind = "global";
                return;
            }
            throw new Error("doom runtime loader did not expose a supported module interface");
        }

        _waitWithTimeout(promise, timeoutMs, timeoutMessage) {
            let timer = 0;
            return new Promise((resolve, reject) => {
                timer = globalScope.setTimeout(() => {
                    reject(new Error(timeoutMessage || "operation timed out"));
                }, Math.max(1, timeoutMs | 0));
                Promise.resolve(promise).then((value) => {
                    globalScope.clearTimeout(timer);
                    resolve(value);
                }).catch((error) => {
                    globalScope.clearTimeout(timer);
                    reject(error);
                });
            });
        }

        _readWadAscii(bytes, offset, len) {
            let out = "";
            const end = Math.min(bytes.length, (offset | 0) + (len | 0));
            for (let i = offset | 0; i < end; i++) {
                const ch = bytes[i];
                if (!ch) break;
                out += String.fromCharCode(ch);
            }
            return out;
        }

        _parseAndValidateWad(bytes) {
            if (!bytes || bytes.length < 12) {
                throw new Error("selected file is not a valid WAD (too small)");
            }
            const sig = this._readWadAscii(bytes, 0, 4).toUpperCase();
            if (sig !== "IWAD" && sig !== "PWAD") {
                throw new Error("selected file is not a WAD (missing IWAD/PWAD header)");
            }
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const lumpCount = view.getInt32(4, true);
            const dirOffset = view.getInt32(8, true);
            if (!Number.isFinite(lumpCount) || lumpCount <= 0 || lumpCount > 200000) {
                throw new Error("WAD header has invalid lump count");
            }
            if (!Number.isFinite(dirOffset) || dirOffset < 12 || dirOffset >= bytes.length) {
                throw new Error("WAD header has invalid directory offset");
            }
            const dirBytes = lumpCount * 16;
            if (dirOffset + dirBytes > bytes.length) {
                throw new Error("WAD directory extends past end of file");
            }
            const lumpNames = new Set();
            for (let i = 0; i < lumpCount; i++) {
                const name = this._readWadAscii(bytes, dirOffset + i * 16 + 8, 8).toUpperCase();
                if (name) lumpNames.add(name);
            }
            const requiredForDoom = ["PLAYPAL", "COLORMAP", "PNAMES", "TEXTURE1", "STBAR"];
            const missing = requiredForDoom.filter((name) => !lumpNames.has(name));
            const info = {
                type: sig,
                lumpCount: lumpCount,
                missingRequiredLumps: missing
            };
            this.lastWadInfo = info;
            if (sig !== "IWAD") {
                throw new Error("selected WAD is PWAD; an IWAD is required to boot DOOM");
            }
            if (missing.length > 0) {
                throw new Error("selected IWAD is missing required lumps: " + missing.join(", "));
            }
            return info;
        }

        _buildLaunchArgs(wadPath) {
            const args = ["-iwad", wadPath];
            if (Array.isArray(this.launchArgs)) {
                for (const item of this.launchArgs) {
                    const value = String(item == null ? "" : item).trim();
                    if (!value) continue;
                    args.push(value);
                }
            }
            return args;
        }

        async _getOrCreateModule(moduleOptions) {
            await this._ensureRuntimeLoader(moduleOptions);
            if (this._moduleKind === "factory") {
                const factory = globalScope[this.factoryName];
                return await factory(moduleOptions);
            }

            // Non-modularized Emscripten builds expose a singleton global Module.
            if (globalScope.Module && globalScope.Module.FS && globalScope.Module.callMain) {
                if (moduleOptions && moduleOptions.canvas) globalScope.Module.canvas = moduleOptions.canvas;
                return globalScope.Module;
            }

            const existing = (globalScope.Module && typeof globalScope.Module === "object") ? globalScope.Module : {};
            const runtimeReady = new Promise((resolve) => {
                const prevOnRuntimeInitialized = existing.onRuntimeInitialized;
                const onRuntimeInitialized = () => {
                    if (typeof prevOnRuntimeInitialized === "function") {
                        try { prevOnRuntimeInitialized(); } catch (_e) {}
                    }
                    resolve(globalScope.Module);
                };
                globalScope.Module = Object.assign(existing, moduleOptions || {}, { onRuntimeInitialized: onRuntimeInitialized });
            });

            await this._ensureRuntimeLoader();
            if (globalScope.Module && globalScope.Module.calledRun) {
                return globalScope.Module;
            }
            return await runtimeReady;
        }

        _startFrameTicker() {
            this._stopFrameTicker();
            const tick = () => {
                if (!this.running) return;
                this.frameVersion++;
                this._rafHandle = globalScope.requestAnimationFrame(tick);
            };
            this._rafHandle = globalScope.requestAnimationFrame(tick);
        }

        _stopFrameTicker() {
            if (!this._rafHandle) return;
            try { globalScope.cancelAnimationFrame(this._rafHandle); } catch (_e) {}
            this._rafHandle = 0;
        }

        async start(wadFile) {
            if (!wadFile) throw new Error("missing wad file");
            if (!(wadFile instanceof File)) throw new Error("invalid wad file");
            await this.stop();
            this.lastError = "";
            try {
                this._emitStatus("Reading WAD file...");

                const bytes = new Uint8Array(await wadFile.arrayBuffer());
                if (!bytes || !bytes.length) {
                    throw new Error("selected WAD file is empty");
                }
                this._emitStatus("Validating WAD contents...");
                this._parseAndValidateWad(bytes);
                this.outputCanvas = this._createCanvas();
            this._ensureCanvasAttached(this.outputCanvas);

                const runtimeReadyPromise = new Promise((resolve) => {
                    this._runtimeReadyResolve = resolve;
                });
                const moduleOptions = {
                    noInitialRun: true,
                    canvas: this.outputCanvas,
                    arguments: [],
                    locateFile: (path) => {
                        if (path && path.endsWith(".wasm") && this.wasmUrl) return this.wasmUrl;
                        return path;
                    },
                    onRuntimeInitialized: () => {
                        if (this._runtimeReadyResolve) {
                            this._runtimeReadyResolve();
                            this._runtimeReadyResolve = null;
                        }
                    }
                };

                this._emitStatus("Initializing DOOM runtime...");
                this.module = await this._getOrCreateModule(moduleOptions);
                if (!this.module || !this.module.FS || !this.module.callMain) {
                    throw new Error("doom runtime module is missing expected APIs");
                }

                // Do not call main until Emscripten has fired onRuntimeInitialized (runDependencies === 0).
                if (!this.module.calledRun) {
                    this._emitStatus("Waiting for runtime dependencies...");
                    await this._waitWithTimeout(runtimeReadyPromise, this.runtimeTimeoutMs, "doom runtime initialization timed out");
                } else if (this._runtimeReadyResolve) {
                    this._runtimeReadyResolve();
                    this._runtimeReadyResolve = null;
                }

                const wadNameSafe = String(wadFile.name || "doom.wad").replace(/[^a-zA-Z0-9._-]/g, "_");
                const wadPath = "/" + wadNameSafe;

                this._emitStatus("Mounting WAD file...");
                if (this.module.FS.chdir) this.module.FS.chdir("/");
                try {
                    if (this.module.FS.analyzePath && this.module.FS.analyzePath(wadPath).exists) {
                        this.module.FS.unlink(wadPath);
                    }
                } catch (_e) {}
                this.module.FS.writeFile(wadPath, bytes);

                const wadExists = !!(
                    this.module.FS &&
                    this.module.FS.analyzePath &&
                    this.module.FS.analyzePath(wadPath).exists
                );
                if (!wadExists) {
                    throw new Error("failed to mount WAD file in runtime filesystem");
                }
                if (this.module.FS.stat) {
                    const wadStat = this.module.FS.stat(wadPath);
                    if (!wadStat || (wadStat.size | 0) <= 0) {
                        throw new Error("mounted WAD file has invalid size");
                    }
                }
                this._mountedWadPath = wadPath;
                if (wadNameSafe !== "doom1.wad") {
                    try {
                        if (this.module.FS.analyzePath("/doom1.wad").exists) this.module.FS.unlink("/doom1.wad");
                        this.module.FS.writeFile("doom1.wad", bytes);
                    } catch (_e) {}
                }

                const launchArgs = this._buildLaunchArgs(wadPath);
                if (this.module.arguments !== undefined) this.module.arguments = launchArgs;
                this._emitStatus("Starting DOOM...");
                if (this.module.callMain) this.module.callMain(launchArgs);
                this.running = true;
                this.lastError = "";
                this.frameVersion = 0;
                this.lastFrameVersionDelivered = 0;
                this._startFrameTicker();
                this._emitStatus("DOOM runtime started");
                return true;
            } catch (error) {
                this.lastError = (error && error.message) ? String(error.message) : "unknown doom startup error";
                if (this.lastError.toLowerCase().includes("indirect call signature mismatch")) {
                    this.lastError = "DOOM runtime crashed while booting the selected WAD. Verify that the WAD is a complete Doom IWAD (for example, a valid DOOM1.WAD).";
                }
                this._emitStatus(this.lastError, "error");
                await this.stop();
                throw error;
            }
        }

        async stop() {
            this._stopFrameTicker();
            this.running = false;
            if (this._runtimeReadyResolve) {
                try { this._runtimeReadyResolve(); } catch (_e) {}
                this._runtimeReadyResolve = null;
            }
            if (this.module) {
                try {
                    if (typeof this.module._emscripten_cancel_main_loop === "function") {
                        this.module._emscripten_cancel_main_loop();
                    }
                } catch (_e) {}
            }
            if (this.module && this._mountedWadPath) {
                try {
                    if (this.module.FS && this.module.FS.analyzePath && this.module.FS.analyzePath(this._mountedWadPath).exists) {
                        this.module.FS.unlink(this._mountedWadPath);
                    }
                } catch (_e) {}
            }
            this._mountedWadPath = "";
            if (this._moduleKind === "factory") this.module = null;
            if (this.outputCanvas && this._moduleKind === "factory" && this.outputCanvas.parentNode) {
                try { this.outputCanvas.parentNode.removeChild(this.outputCanvas); } catch (_e) {}
            }
            if (this._moduleKind === "factory") this.outputCanvas = null;
            this.lastFrameVersionDelivered = 0;
        }

        isRunning() {
            return this.running === true;
        }

        getFrameSource() {
            if (!this.isRunning()) return null;
            return this.outputCanvas;
        }

        updateFrameClock(_nowMs) {
            if (!this.isRunning()) return false;
            if (this.frameVersion > this.lastFrameVersionDelivered) {
                this.lastFrameVersionDelivered = this.frameVersion;
                return true;
            }
            return false;
        }

        sendKeyEvent(event, type = "down") {
            if (!this.isRunning() || !event) return false;
            if (typeof this.module.SDL === "undefined") {
                return false;
            }
            try {
                const target = this.outputCanvas || globalScope;
                const cloned = new KeyboardEvent(type === "up" ? "keyup" : "keydown", {
                    key: event.key,
                    code: event.code,
                    altKey: !!event.altKey,
                    ctrlKey: !!event.ctrlKey,
                    shiftKey: !!event.shiftKey,
                    metaKey: !!event.metaKey,
                    repeat: !!event.repeat
                });
                target.dispatchEvent(cloned);
                return true;
            } catch (_e) {
                return false;
            }
        }
    }

    globalScope.JigsawDoomRuntimeAdapter = DoomRuntimeAdapter;
})(window);

