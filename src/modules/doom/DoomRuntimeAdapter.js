"use strict";

(function initDoomRuntimeAdapter(globalScope) {
    /**
     * User-friendly runtime defaults for DOOM.
     *
     * If you are integrating via the module manifest, prefer overriding these
     * through that manifest entry instead of editing runtime internals.
     */
    const DOOM_RUNTIME_DEFAULTS = Object.freeze({
        loaderUrl: "",
        wasmUrl: "",
        factoryName: "createDoomGenericModule",
        canvasWidth: 320,
        canvasHeight: 200,
        launchArgs: [],
        loaderTimeoutMs: 20000,
        runtimeTimeoutMs: 30000,
        persistAutoSyncMs: 2000
    });

    /**
     * @param {{
     *   loaderUrl?: string,
     *   wasmUrl?: string,
     *   factoryName?: string,
     *   canvasWidth?: number,
     *   canvasHeight?: number,
     *   launchArgs?: string[],
     *   onStatus?: ((payload:{message:string,level:string})=>void)|null,
     *   onExit?: ((payload:{reason:string,detail:Object|null})=>void)|null,
     *   loaderTimeoutMs?: number,
     *   runtimeTimeoutMs?: number,
     *   persistAutoSyncMs?: number
     * }} options
     */
    class DoomRuntimeAdapter {
        constructor(options = {}) {
            this.loaderUrl = options.loaderUrl || DOOM_RUNTIME_DEFAULTS.loaderUrl;
            this.wasmUrl = options.wasmUrl || DOOM_RUNTIME_DEFAULTS.wasmUrl;
            this.factoryName = options.factoryName || DOOM_RUNTIME_DEFAULTS.factoryName;
            this.canvasWidth = options.canvasWidth || DOOM_RUNTIME_DEFAULTS.canvasWidth;
            this.canvasHeight = options.canvasHeight || DOOM_RUNTIME_DEFAULTS.canvasHeight;
            this.launchArgs = Array.isArray(options.launchArgs) ? options.launchArgs.slice() : [];
            this.onStatus = typeof options.onStatus === "function" ? options.onStatus : null;
            this.onExit = typeof options.onExit === "function" ? options.onExit : null;
            this.module = null;
            this.outputCanvas = null;
            this.running = false;
            this.lastError = "";
            this.frameVersion = 0;
            this.lastFrameVersionDelivered = 0;
            this._rafHandle = 0;
            this._loaderPromise = null;
            this._mountedIwadPath = "";
            this._mountedPwadPath = "";
            this._moduleKind = "";
            this._runtimeReadyResolve = null;
            this.loaderTimeoutMs = Math.max(1000, Number(options.loaderTimeoutMs) || DOOM_RUNTIME_DEFAULTS.loaderTimeoutMs);
            this.runtimeTimeoutMs = Math.max(1000, Number(options.runtimeTimeoutMs) || DOOM_RUNTIME_DEFAULTS.runtimeTimeoutMs);
            this.lastWadInfo = null;
            this._runtimeExitNotified = false;
            this._titleBeforeStart = "";
            this._titleObserver = null;
            this._titleEnforceTimer = 0;
            this._loaderScriptEl = null;
            this._paused = false;
            this._loadedWadSignature = "";
            this._runtimeErrorHandler = null;
            this._runtimeRejectionHandler = null;
            this._suppressRuntimeErrorsUntil = 0;
            this._runtimeGuardCleanupTimer = 0;
            this._cachedIwadBytes = null;
            this._cachedIwadName = "";
            this._cachedPwadBytes = null;
            this._cachedPwadName = "";
            this._resumePoisoned = false;
            this._persistMountPath = "/jigsaw_persist";
            this._persistentMounted = false;
            this._persistConfigPath = this._persistMountPath + "/default.cfg";
            this._persistAutoSyncTimer = 0;
            this._persistSyncInFlight = false;
            this._persistAutoSyncMs = Math.max(1000, Number(options.persistAutoSyncMs) || DOOM_RUNTIME_DEFAULTS.persistAutoSyncMs);
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
                    if (this._loaderScriptEl && this._loaderScriptEl.parentNode) {
                        try { this._loaderScriptEl.parentNode.removeChild(this._loaderScriptEl); } catch (_e) {}
                    }
                    const script = document.createElement("script");
                    script.src = this.loaderUrl;
                    script.async = true;
                    script.crossOrigin = "anonymous";
                    this._loaderScriptEl = script;
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
            // Non-modularized builds can populate FS/callMain later in async startup.
            // Treat this as pending-global and let _getOrCreateModule wait for readiness.
            if (globalScope.Module && typeof globalScope.Module === "object") {
                this._moduleKind = "global-pending";
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

        async _syncFs(populate) {
            if (!this.module || !this.module.FS || typeof this.module.FS.syncfs !== "function") return false;
            await new Promise((resolve, reject) => {
                try {
                    this.module.FS.syncfs(!!populate, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                } catch (error) {
                    reject(error);
                }
            });
            return true;
        }

        async _ensurePersistentStorageMounted() {
            if (!this.module || !this.module.FS) {
                this._persistentMounted = false;
                return false;
            }
            // Factory-based restarts recreate Module/FS. If we retained a stale
            // "mounted" flag from a previous instance, force remount/sync now.
            if (this._persistentMounted) {
                try {
                    const analyzed = this.module.FS.analyzePath(this._persistMountPath);
                    if (analyzed && analyzed.exists) return true;
                } catch (_e) {}
                this._persistentMounted = false;
            }
            const FS = this.module.FS;
            const idbfsCandidate = this.module.IDBFS || (FS.filesystems && FS.filesystems.IDBFS) || globalScope.IDBFS;
            const hasUsableIdbfs = !!(
                idbfsCandidate &&
                typeof idbfsCandidate === "object" &&
                typeof idbfsCandidate.mount === "function"
            );
            if (hasUsableIdbfs && typeof FS.mount === "function") {
                try {
                    if (!FS.analyzePath(this._persistMountPath).exists) {
                        FS.mkdir(this._persistMountPath);
                    }
                } catch (_e) {}
                try {
                    FS.mount(idbfsCandidate, {}, this._persistMountPath);
                } catch (_e) {
                    // Ignore "already mounted" and continue.
                }
                this._persistentMounted = true;
            } else {
                this._emitStatus("DOOM persistent settings unavailable (IDBFS backend missing).", "warn");
                return false;
            }
            try {
                await this._syncFs(true);
                const ok = await this._verifyPersistentBackendReady();
                if (!ok) {
                    this._emitStatus("DOOM persistent settings backend failed verification: idbfs write/read/sync probe failed.", "error");
                    return false;
                }
                if (this._sanitizePersistentConfigToSoundOnly()) {
                    await this._syncFs(false);
                }
                return true;
            } catch (error) {
                this._emitStatus("DOOM persistent settings load failed: " + (error && error.message ? error.message : String(error)), "warn");
                return false;
            }
        }

        async _verifyPersistentBackendReady() {
            if (!this.module || !this.module.FS) return false;
            const FS = this.module.FS;
            const probePath = this._persistMountPath + "/.__jigsaw_persist_probe__";
            const probePayload = "jigsaw-persist-probe:" + String(Date.now());
            try {
                FS.writeFile(probePath, probePayload);
                const immediate = FS.readFile(probePath, { encoding: "utf8" });
                if (String(immediate || "") !== probePayload) return false;
                await this._syncFs(false);
                await this._syncFs(true);
                const afterSync = FS.readFile(probePath, { encoding: "utf8" });
                if (String(afterSync || "") !== probePayload) return false;
                try { FS.unlink(probePath); } catch (_e) {}
                await this._syncFs(false);
                return true;
            } catch (_e) {
                return false;
            }
        }

        _getPreferredRuntimeConfigPath() {
            return this._persistConfigPath;
        }

        _isSoundConfigKey(keyName) {
            const key = String(keyName || "").trim().toLowerCase();
            if (!key) return false;
            return key === "sfx_volume" || key === "music_volume";
        }

        _sanitizeConfigTextToSoundOnly(cfgText) {
            const original = String(cfgText == null ? "" : cfgText);
            if (!original) return original;
            const useCrlf = original.includes("\r\n");
            const eol = useCrlf ? "\r\n" : "\n";
            const hadTrailingNewline = /\r?\n$/.test(original);
            const lines = original.split(/\r?\n/);
            const kept = [];
            for (const line of lines) {
                const trimmed = String(line || "").trim();
                if (!trimmed) {
                    kept.push(line);
                    continue;
                }
                if (trimmed.startsWith("#") || trimmed.startsWith("//")) {
                    kept.push(line);
                    continue;
                }
                const keyMatch = trimmed.match(/^([A-Za-z0-9_]+)/);
                if (!keyMatch) {
                    kept.push(line);
                    continue;
                }
                if (this._isSoundConfigKey(keyMatch[1])) {
                    kept.push(line);
                }
            }
            let output = kept.join(eol);
            if (hadTrailingNewline && output && !/\r?\n$/.test(output)) output += eol;
            return output;
        }

        _sanitizePersistentConfigToSoundOnly() {
            if (!this.module || !this.module.FS) return false;
            const FS = this.module.FS;
            const cfgPath = this._getPreferredRuntimeConfigPath();
            try {
                if (!FS.analyzePath(cfgPath).exists) return false;
                const currentText = String(FS.readFile(cfgPath, { encoding: "utf8" }) || "");
                const sanitizedText = this._sanitizeConfigTextToSoundOnly(currentText);
                if (sanitizedText === currentText) return false;
                FS.writeFile(cfgPath, sanitizedText);
                return true;
            } catch (error) {
                this._emitStatus("DOOM config sanitize failed: " + (error && error.message ? error.message : String(error)), "warn");
                return false;
            }
        }

        _resumeAudioContextBestEffort() {
            try {
                const sdl2 = this.module && this.module.SDL2 ? this.module.SDL2 : null;
                if (sdl2 && sdl2.audioContext && typeof sdl2.audioContext.resume === "function") {
                    const maybeResumePromise = sdl2.audioContext.resume();
                    if (maybeResumePromise && typeof maybeResumePromise.catch === "function") {
                        maybeResumePromise.catch(() => {});
                    }
                }
            } catch (_e) {}
        }

        _hasUsableAudioContextForResume() {
            try {
                const sdl2 = this.module && this.module.SDL2 ? this.module.SDL2 : null;
                const ctx = sdl2 && sdl2.audioContext ? sdl2.audioContext : null;
                if (!ctx) return false;
                const state = ctx && ctx.state ? String(ctx.state) : "";
                return state !== "closed";
            } catch (_e) {
                return false;
            }
        }

        _requestRuntimeConfigSaveBestEffort() {
            const m = this.module;
            if (!m) return false;
            try {
                if (typeof m._M_SaveDefaults === "function") {
                    m._M_SaveDefaults();
                    return true;
                }
            } catch (_e) {}
            return false;
        }

        async _flushPersistentConfigNow() {
            if (!this._persistentMounted || this._persistSyncInFlight) return false;
            this._persistSyncInFlight = true;
            try {
                this._requestRuntimeConfigSaveBestEffort();
                this._sanitizePersistentConfigToSoundOnly();
                await this._syncFs(false);
                return true;
            } catch (error) {
                this._emitStatus("DOOM persistent settings save failed: " + (error && error.message ? error.message : String(error)), "warn");
                return false;
            } finally {
                this._persistSyncInFlight = false;
            }
        }

        _stopPersistentAutoSync() {
            if (!this._persistAutoSyncTimer) return;
            try { globalScope.clearInterval(this._persistAutoSyncTimer); } catch (_e) {}
            this._persistAutoSyncTimer = 0;
        }

        _startPersistentAutoSync() {
            this._stopPersistentAutoSync();
            if (!this._persistentMounted) return;
            this._persistAutoSyncTimer = globalScope.setInterval(() => {
                // Fire-and-forget best effort while runtime is active.
                this._flushPersistentConfigNow().catch(() => {});
            }, this._persistAutoSyncMs);
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

        _extractRequestedWadFiles(payload) {
            if (!payload) {
                return { iwadFile: null, pwadFile: null, explicitPayload: false };
            }
            if (payload instanceof File) {
                return { iwadFile: payload, pwadFile: null, explicitPayload: false };
            }
            if (typeof payload !== "object") {
                throw new Error("invalid wad payload");
            }
            const iwadFile = payload.iwad || payload.file || null;
            const pwadFile = payload.pwad || payload.patch || null;
            if (iwadFile && !(iwadFile instanceof File)) throw new Error("invalid iwad file");
            if (pwadFile && !(pwadFile instanceof File)) throw new Error("invalid pwad file");
            return { iwadFile: iwadFile || null, pwadFile: pwadFile || null, explicitPayload: true };
        }

        _isEpisodeStyleMapName(name) {
            return /^E[1-9]M[1-9]$/.test(String(name || "").toUpperCase());
        }

        _isMapStyleMapName(name) {
            return /^MAP[0-9][0-9]$/.test(String(name || "").toUpperCase());
        }

        _analyzeWad(bytes, expectedType = "") {
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
            const lumpNameList = [];
            const lumpEntries = [];
            let episodeStyleMapCount = 0;
            let mapStyleMapCount = 0;
            let invalidLumpCount = 0;
            for (let i = 0; i < lumpCount; i++) {
                const lumpOffset = dirOffset + i * 16;
                const lumpFilePos = view.getInt32(lumpOffset, true);
                const lumpSize = view.getInt32(lumpOffset + 4, true);
                const name = this._readWadAscii(bytes, dirOffset + i * 16 + 8, 8).toUpperCase();
                if (name) {
                    lumpNames.add(name);
                    lumpNameList.push(name);
                    if (this._isEpisodeStyleMapName(name)) episodeStyleMapCount++;
                    if (this._isMapStyleMapName(name)) mapStyleMapCount++;
                }
                const entry = {
                    index: i,
                    name: name || "",
                    filePos: lumpFilePos,
                    size: lumpSize
                };
                if (!Number.isFinite(lumpFilePos) || !Number.isFinite(lumpSize) || lumpFilePos < 0 || lumpSize < 0 || (lumpFilePos + lumpSize) > bytes.length) {
                    entry.invalidBounds = true;
                    invalidLumpCount++;
                } else {
                    entry.invalidBounds = false;
                }
                lumpEntries.push(entry);
            }
            if (invalidLumpCount > 0) {
                throw new Error("WAD has invalid lump bounds (" + invalidLumpCount + " entries out of range)");
            }
            const requiredForDoom = ["PLAYPAL", "COLORMAP", "PNAMES", "TEXTURE1", "STBAR"];
            const missing = requiredForDoom.filter((name) => !lumpNames.has(name));
            const info = {
                type: sig,
                lumpCount: lumpCount,
                missingRequiredLumps: missing,
                lumpNames: lumpNames,
                lumpNameList: lumpNameList,
                lumpEntries: lumpEntries,
                mapStyle: episodeStyleMapCount > 0 && mapStyleMapCount === 0
                    ? "episode"
                    : (mapStyleMapCount > 0 && episodeStyleMapCount === 0 ? "map" : "mixed"),
                mapCount: episodeStyleMapCount + mapStyleMapCount
            };
            const normalizedExpected = String(expectedType || "").toUpperCase().trim();
            if (normalizedExpected === "IWAD" && sig !== "IWAD") {
                throw new Error("selected WAD is PWAD; an IWAD is required to boot DOOM");
            }
            if (normalizedExpected === "PWAD" && sig !== "PWAD") {
                throw new Error("selected WAD is IWAD; choose a PWAD for optional mod loading");
            }
            if (sig === "IWAD" && missing.length > 0) {
                throw new Error("selected IWAD is missing required lumps: " + missing.join(", "));
            }
            return info;
        }

        _parseAndValidateWad(bytes, expectedType = "") {
            return this._analyzeWad(bytes, expectedType);
        }

        _collectPwadCompatibilityWarnings(iwadInfo, pwadInfo) {
            const warnings = [];
            if (!pwadInfo) return warnings;
            const lumpNames = pwadInfo.lumpNames || new Set();
            const hasName = (name) => lumpNames.has(String(name || "").toUpperCase());
            const zdoomFlags = ["MAPINFO", "UMAPINFO", "DECORATE", "ZSCRIPT", "SBARINFO", "ANIMDEFS", "GLDEFS", "LANGUAGE", "SNDINFO"];
            const flagged = zdoomFlags.filter((name) => hasName(name));
            if (flagged.length > 0) {
                warnings.push("PWAD includes advanced port lumps (" + flagged.join(", ") + "); this build may not support them.");
            }
            if (pwadInfo.mapCount <= 0 && !hasName("DEHACKED")) {
                warnings.push("PWAD contains no obvious map lumps; it may rely on unsupported patch behavior.");
            }
            if (iwadInfo && iwadInfo.mapStyle && pwadInfo.mapStyle && iwadInfo.mapStyle !== "mixed" && pwadInfo.mapStyle !== "mixed" && iwadInfo.mapStyle !== pwadInfo.mapStyle) {
                warnings.push("PWAD map naming style (" + pwadInfo.mapStyle + ") differs from IWAD (" + iwadInfo.mapStyle + "); map replacement may fail.");
            }
            return warnings;
        }

        async validateStartPayload(payload = null) {
            const errors = [];
            const warnings = [];
            let iwadInfo = null;
            let pwadInfo = null;
            try {
                const requested = this._extractRequestedWadFiles(payload);
                const iwadFile = requested.iwadFile;
                const pwadFile = requested.pwadFile;
                const explicitPayload = !!requested.explicitPayload;
                const hasIwadFile = !!iwadFile;
                const hasPwadFile = !!pwadFile;
                const cachedIwadAvailable = !!(this._cachedIwadBytes && this._cachedIwadBytes.length);
                const cachedPwadAvailable = !!(this._cachedPwadBytes && this._cachedPwadBytes.length);
                const shouldUseCachedPwad = !explicitPayload && !hasPwadFile && cachedPwadAvailable;
                let iwadBytes = null;
                let pwadBytes = null;
                if (hasIwadFile) {
                    iwadBytes = new Uint8Array(await iwadFile.arrayBuffer());
                } else if (cachedIwadAvailable) {
                    iwadBytes = new Uint8Array(this._cachedIwadBytes);
                } else {
                    errors.push("Missing IWAD file.");
                }
                if (hasPwadFile) {
                    pwadBytes = new Uint8Array(await pwadFile.arrayBuffer());
                } else if (shouldUseCachedPwad) {
                    pwadBytes = new Uint8Array(this._cachedPwadBytes);
                }
                if (iwadBytes && iwadBytes.length) {
                    try {
                        iwadInfo = this._analyzeWad(iwadBytes, "IWAD");
                    } catch (error) {
                        errors.push(error && error.message ? String(error.message) : "IWAD validation failed.");
                    }
                } else if (!errors.length) {
                    errors.push("IWAD file is empty.");
                }
                if (pwadBytes && pwadBytes.length) {
                    try {
                        pwadInfo = this._analyzeWad(pwadBytes, "PWAD");
                    } catch (error) {
                        errors.push(error && error.message ? String(error.message) : "PWAD validation failed.");
                    }
                }
                if (!errors.length && iwadInfo) {
                    warnings.push.apply(warnings, this._collectPwadCompatibilityWarnings(iwadInfo, pwadInfo));
                }
            } catch (error) {
                errors.push(error && error.message ? String(error.message) : "WAD compatibility preflight failed.");
            }
            return {
                ok: errors.length === 0,
                errors: errors,
                warnings: warnings,
                metadata: {
                    iwad: iwadInfo || null,
                    pwad: pwadInfo || null
                }
            };
        }

        _buildLaunchArgs(iwadPath, pwadPath = "") {
            const args = ["-iwad", iwadPath];
            if (pwadPath) {
                args.push("-file", pwadPath);
            }
            if (Array.isArray(this.launchArgs)) {
                for (const item of this.launchArgs) {
                    const value = String(item == null ? "" : item).trim();
                    if (!value) continue;
                    args.push(value);
                }
            }
            // Force a deterministic absolute config path unless caller already set one.
            let hasExplicitConfig = false;
            for (let i = 0; i < args.length; i++) {
                if (String(args[i]).toLowerCase() === "-config") {
                    hasExplicitConfig = true;
                    break;
                }
            }
            if (!hasExplicitConfig) {
                args.push("-config", this._getPreferredRuntimeConfigPath());
            }
            return args;
        }

        _notifyRuntimeExit(reason, detail = null) {
            if (this._runtimeExitNotified) return;
            this._runtimeExitNotified = true;
            this.running = false;
            // Runtime exits (quit/abort/crash) are not safe to resume: SDL may have
            // already torn down subsystems like WebAudio.
            this._resumePoisoned = true;
            this._paused = false;
            this._loadedWadSignature = "";
            // In non-modularized builds, async callbacks can still flush briefly after quit.
            // Suppress known teardown race errors during this grace window.
            this._suppressRuntimeErrorsUntil = Date.now() + 5000;
            this._haltRuntimeLoopBestEffort();
            const suffix = reason ? " (" + reason + ")" : "";
            this._emitStatus("DOOM runtime exited" + suffix, "info");
            if (this.onExit) {
                try {
                    this.onExit({ reason: reason || "exit", detail: detail || null });
                } catch (_e) {}
            }
        }

        _isLikelyQuitRaceError(messageText) {
            const msg = String(messageText || "").toLowerCase();
            return msg.includes("indirect call signature mismatch")
                || msg.includes("index out of bounds")
                || msg.includes("stack overflow detected");
        }

        _haltRuntimeLoopBestEffort() {
            try {
                if (this.module && typeof this.module.pauseMainLoop === "function") {
                    try { this.module.pauseMainLoop(); } catch (_e) {}
                    this._paused = true;
                }
                if (this.module && typeof this.module._DG_CancelMainLoop === "function") {
                    try { this.module._DG_CancelMainLoop(); } catch (_e) {}
                } else if (this.module && typeof this.module.emscripten_cancel_main_loop === "function") {
                    try { this.module.emscripten_cancel_main_loop(); } catch (_e) {}
                } else if (this.module && typeof this.module._emscripten_cancel_main_loop === "function") {
                    try { this.module._emscripten_cancel_main_loop(); } catch (_e) {}
                }
                // Some builds still retain MainLoop.func after cancellation; clear it
                // so a subsequent callMain can safely install a new loop.
                const ml = this.module && this.module.MainLoop ? this.module.MainLoop : null;
                if (ml) {
                    try { ml.func = null; } catch (_e) {}
                    try { ml.running = false; } catch (_e) {}
                }
            } catch (_e) {}
        }

        _isWithinRuntimeErrorSuppressionWindow() {
            return Date.now() < (this._suppressRuntimeErrorsUntil || 0);
        }

        _isLikelyFromDoomRuntime(eventLike) {
            const filename = eventLike && eventLike.filename ? String(eventLike.filename) : "";
            if (filename.includes("doomgeneric.js") || filename.includes("doomgeneric.wasm")) return true;
            const err = eventLike && eventLike.error ? eventLike.error : null;
            const stack = err && err.stack ? String(err.stack) : "";
            return stack.includes("doomgeneric.js") || stack.includes("doomgeneric.wasm");
        }

        _installRuntimeErrorGuards() {
            this._cancelRuntimeGuardCleanup();
            this._removeRuntimeErrorGuards();
            const onWindowError = (event) => {
                const message = event && event.message ? String(event.message) : "";
                const likelyQuitRace = this._isLikelyQuitRaceError(message);
                if (!likelyQuitRace) return;
                const fromDoom = this._isLikelyFromDoomRuntime(event);
                if (!fromDoom && !this.running && !this._isWithinRuntimeErrorSuppressionWindow()) return;
                if (!this.running && !this._isWithinRuntimeErrorSuppressionWindow()) return;
                this._haltRuntimeLoopBestEffort();
                this._notifyRuntimeExit("runtime-error", { message: message });
                if (event && typeof event.preventDefault === "function") event.preventDefault();
                if (event && typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
                return true;
            };
            const onUnhandledRejection = (event) => {
                const reasonText = event && event.reason ? String(event.reason) : "";
                const likelyQuitRace = this._isLikelyQuitRaceError(reasonText);
                if (!likelyQuitRace) return;
                if (!this.running && !this._isWithinRuntimeErrorSuppressionWindow()) return;
                this._haltRuntimeLoopBestEffort();
                this._notifyRuntimeExit("runtime-rejection", { message: reasonText });
                if (event && typeof event.preventDefault === "function") event.preventDefault();
                if (event && typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
            };
            this._runtimeErrorHandler = onWindowError;
            this._runtimeRejectionHandler = onUnhandledRejection;
            if (typeof globalScope.addEventListener === "function") {
                globalScope.addEventListener("error", onWindowError, true);
                globalScope.addEventListener("unhandledrejection", onUnhandledRejection, true);
            }
        }

        _cancelRuntimeGuardCleanup() {
            if (!this._runtimeGuardCleanupTimer) return;
            try { globalScope.clearTimeout(this._runtimeGuardCleanupTimer); } catch (_e) {}
            this._runtimeGuardCleanupTimer = 0;
        }

        _scheduleRuntimeGuardCleanup(delayMs = 0) {
            this._cancelRuntimeGuardCleanup();
            const waitMs = Math.max(0, Number(delayMs) || 0);
            this._runtimeGuardCleanupTimer = globalScope.setTimeout(() => {
                this._runtimeGuardCleanupTimer = 0;
                this._suppressRuntimeErrorsUntil = 0;
                this._removeRuntimeErrorGuards();
            }, waitMs);
        }

        _removeRuntimeErrorGuards() {
            if (typeof globalScope.removeEventListener === "function") {
                if (this._runtimeErrorHandler) globalScope.removeEventListener("error", this._runtimeErrorHandler, true);
                if (this._runtimeRejectionHandler) globalScope.removeEventListener("unhandledrejection", this._runtimeRejectionHandler, true);
            }
            this._runtimeErrorHandler = null;
            this._runtimeRejectionHandler = null;
        }

        _startTitleGuard() {
            this._stopTitleGuard();
            if (!globalScope.document) return;
            this._titleBeforeStart = String(globalScope.document.title || "");
            const enforceTitle = () => {
                if (!globalScope.document) return;
                if (globalScope.document.title !== this._titleBeforeStart) {
                    globalScope.document.title = this._titleBeforeStart;
                }
            };
            enforceTitle();
            this._titleEnforceTimer = globalScope.setInterval(enforceTitle, 250);
            try {
                const titleEl = globalScope.document.querySelector("title");
                if (titleEl && typeof MutationObserver !== "undefined") {
                    this._titleObserver = new MutationObserver(enforceTitle);
                    this._titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
                }
            } catch (_e) {}
        }

        _stopTitleGuard() {
            if (this._titleObserver) {
                try { this._titleObserver.disconnect(); } catch (_e) {}
                this._titleObserver = null;
            }
            if (this._titleEnforceTimer) {
                try { globalScope.clearInterval(this._titleEnforceTimer); } catch (_e) {}
                this._titleEnforceTimer = 0;
            }
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
            const moduleFromRuntime = await runtimeReady;
            if (moduleFromRuntime && moduleFromRuntime.FS && moduleFromRuntime.callMain) {
                this._moduleKind = "global";
                return moduleFromRuntime;
            }
            throw new Error("doom runtime global module did not become ready");
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

        async start(payload = null) {
            const requested = this._extractRequestedWadFiles(payload);
            const iwadFile = requested.iwadFile;
            const pwadFile = requested.pwadFile;
            const explicitPayload = !!requested.explicitPayload;
            const hasIwadFile = !!iwadFile;
            const hasPwadFile = !!pwadFile;
            const cachedIwadAvailable = !!(this._cachedIwadBytes && this._cachedIwadBytes.length);
            const cachedPwadAvailable = !!(this._cachedPwadBytes && this._cachedPwadBytes.length);
            const shouldUseCachedPwad = !explicitPayload && !hasPwadFile && cachedPwadAvailable;
            const effectiveIwadName = hasIwadFile
                ? String(iwadFile.name || "doom.wad")
                : (this._cachedIwadName || "doom.wad");
            const effectiveIwadSize = hasIwadFile
                ? Number(iwadFile.size || 0)
                : (cachedIwadAvailable ? Number(this._cachedIwadBytes.length || 0) : 0);
            const effectivePwadName = hasPwadFile
                ? String(pwadFile.name || "mod.wad")
                : (shouldUseCachedPwad ? (this._cachedPwadName || "mod.wad") : "");
            const effectivePwadSize = hasPwadFile
                ? Number(pwadFile.size || 0)
                : (shouldUseCachedPwad ? Number(this._cachedPwadBytes.length || 0) : 0);
            const requestedWadSignature = [
                effectiveIwadName + ":" + effectiveIwadSize,
                effectivePwadName + ":" + effectivePwadSize
            ].join("|");

            const canResumePausedRuntime = (
                this._paused &&
                this.module &&
                typeof this.module.resumeMainLoop === "function" &&
                !this._resumePoisoned &&
                this._hasUsableAudioContextForResume()
            );
            if (canResumePausedRuntime) {
                // If no new WADs are provided, resume previously loaded data.
                // If any new WAD is provided, only allow resume when signatures match.
                if ((hasIwadFile || hasPwadFile) && this._loadedWadSignature && requestedWadSignature !== this._loadedWadSignature) {
                    // Fall through to clean restart path.
                } else {
                    this._emitStatus("Resuming paused DOOM runtime...");
                    this._resumeAudioContextBestEffort();
                    this._startTitleGuard();
                    this.running = true;
                    this._paused = false;
                    this._suppressRuntimeErrorsUntil = 0;
                    this._installRuntimeErrorGuards();
                    try { this.module.resumeMainLoop(); } catch (_e) {}
                    try {
                        globalScope.setTimeout(() => this._resumeAudioContextBestEffort(), 0);
                        globalScope.setTimeout(() => this._resumeAudioContextBestEffort(), 250);
                    } catch (_e) {}
                    this._startFrameTicker();
                    this._startPersistentAutoSync();
                    return true;
                }
            }

            // We are not doing a main-loop resume; ensure any prior paused loop is fully torn down
            // before calling main again to avoid "there can only be one main loop" assertions.
            if (this.running || this._paused) {
                await this.stop();
            }

            let iwadBytes = null;
            let pwadBytes = null;
            if (hasIwadFile) {
                this._emitStatus("Reading IWAD file...");
                iwadBytes = new Uint8Array(await iwadFile.arrayBuffer());
                if (!iwadBytes || !iwadBytes.length) {
                    throw new Error("selected IWAD file is empty");
                }
                this._cachedIwadBytes = new Uint8Array(iwadBytes);
                this._cachedIwadName = effectiveIwadName;
            } else if (cachedIwadAvailable) {
                this._emitStatus("Using cached IWAD for clean restart...");
                iwadBytes = new Uint8Array(this._cachedIwadBytes);
            } else {
                throw new Error("missing IWAD file");
            }
            if (hasPwadFile) {
                this._emitStatus("Reading PWAD file...");
                pwadBytes = new Uint8Array(await pwadFile.arrayBuffer());
                if (!pwadBytes || !pwadBytes.length) {
                    throw new Error("selected PWAD file is empty");
                }
                this._cachedPwadBytes = new Uint8Array(pwadBytes);
                this._cachedPwadName = effectivePwadName;
            } else if (shouldUseCachedPwad) {
                this._emitStatus("Using cached PWAD for clean restart...");
                pwadBytes = new Uint8Array(this._cachedPwadBytes);
            } else {
                this._cachedPwadBytes = null;
                this._cachedPwadName = "";
            }

            this.lastError = "";
            this._runtimeExitNotified = false;
            try {
                this._emitStatus("Validating IWAD contents...");
                const iwadInfo = this._parseAndValidateWad(iwadBytes, "IWAD");
                let pwadInfo = null;
                if (pwadBytes && pwadBytes.length) {
                    this._emitStatus("Validating PWAD contents...");
                    pwadInfo = this._parseAndValidateWad(pwadBytes, "PWAD");
                }
                this.lastWadInfo = {
                    iwad: iwadInfo,
                    pwad: pwadInfo
                };
                this.outputCanvas = this._createCanvas();
                this._ensureCanvasAttached(this.outputCanvas);

                const runtimeReadyPromise = new Promise((resolve) => {
                    this._runtimeReadyResolve = resolve;
                });
                const moduleOptions = {
                    noInitialRun: true,
                    canvas: this.outputCanvas,
                    arguments: [],
                    printErr: (text) => {
                        const msg = String(text == null ? "" : text);
                        if (msg.includes("emscripten_set_main_loop_timing: Cannot set timing mode for main loop since a main loop does not exist")) {
                            return;
                        }
                        try { console.error(msg); } catch (_e) {}
                    },
                    quit: (status, toThrow) => {
                        this._notifyRuntimeExit("quit", { status: status || 0 });
                        if ((status | 0) === 0) return;
                        if (toThrow) throw toThrow;
                        throw new Error("DOOM runtime quit with status " + status);
                    },
                    onAbort: (what) => {
                        const msg = what == null ? "" : String(what);
                        this._notifyRuntimeExit("abort", { message: msg });
                    },
                    onExit: (status) => {
                        this._notifyRuntimeExit("exit", { status: status || 0 });
                    },
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
                const persistReady = await this._ensurePersistentStorageMounted();
                if (!persistReady) {
                    throw new Error("persistent storage backend is not ready");
                }

                const iwadNameSafe = String(effectiveIwadName || "doom.wad").replace(/[^a-zA-Z0-9._-]/g, "_");
                const iwadPath = "/" + iwadNameSafe;
                const pwadNameSafe = effectivePwadName
                    ? String(effectivePwadName).replace(/[^a-zA-Z0-9._-]/g, "_")
                    : "";
                const pwadPath = pwadNameSafe ? ("/" + pwadNameSafe) : "";

                this._emitStatus("Mounting WAD files...");
                if (this.module.FS.chdir) this.module.FS.chdir("/");
                try {
                    if (this.module.FS.analyzePath && this.module.FS.analyzePath(iwadPath).exists) {
                        this.module.FS.unlink(iwadPath);
                    }
                } catch (_e) {}
                this.module.FS.writeFile(iwadPath, iwadBytes);
                const iwadExists = !!(
                    this.module.FS &&
                    this.module.FS.analyzePath &&
                    this.module.FS.analyzePath(iwadPath).exists
                );
                if (!iwadExists) {
                    throw new Error("failed to mount IWAD file in runtime filesystem");
                }
                if (this.module.FS.stat) {
                    const iwadStat = this.module.FS.stat(iwadPath);
                    if (!iwadStat || (iwadStat.size | 0) <= 0) {
                        throw new Error("mounted IWAD file has invalid size");
                    }
                }
                this._mountedIwadPath = iwadPath;
                this._mountedPwadPath = "";
                if (iwadNameSafe !== "doom1.wad") {
                    try {
                        if (this.module.FS.analyzePath("/doom1.wad").exists) this.module.FS.unlink("/doom1.wad");
                        this.module.FS.writeFile("doom1.wad", iwadBytes);
                    } catch (_e) {}
                }
                if (pwadPath) {
                    try {
                        if (this.module.FS.analyzePath && this.module.FS.analyzePath(pwadPath).exists) {
                            this.module.FS.unlink(pwadPath);
                        }
                    } catch (_e) {}
                    this.module.FS.writeFile(pwadPath, pwadBytes);
                    const pwadExists = !!(
                        this.module.FS &&
                        this.module.FS.analyzePath &&
                        this.module.FS.analyzePath(pwadPath).exists
                    );
                    if (!pwadExists) {
                        throw new Error("failed to mount PWAD file in runtime filesystem");
                    }
                    if (this.module.FS.stat) {
                        const pwadStat = this.module.FS.stat(pwadPath);
                        if (!pwadStat || (pwadStat.size | 0) <= 0) {
                            throw new Error("mounted PWAD file has invalid size");
                        }
                    }
                    this._mountedPwadPath = pwadPath;
                }

                const launchArgs = this._buildLaunchArgs(iwadPath, pwadPath);
                if (this.module.arguments !== undefined) this.module.arguments = launchArgs;
                this._emitStatus("Starting DOOM...");
                this._startTitleGuard();
                try {
                    // In IDBFS mode, keep cwd in persistent mount so relative save paths
                    // (e.g. ./.savegame/) also persist without extra copy logic.
                    if (this.module.FS && typeof this.module.FS.chdir === "function") {
                        this.module.FS.chdir(this._persistMountPath);
                    }
                } catch (_e) {}
                // Extra safety: ensure no stale Emscripten loop remains before callMain.
                // Some quit/restart paths can leave loop state around despite earlier stop().
                this._haltRuntimeLoopBestEffort();
                this._paused = false;
                this._resumeAudioContextBestEffort();
                if (this.module.callMain) this.module.callMain(launchArgs);
                // Some SDL/Emscripten builds create audio context shortly after main starts.
                // Retry resume after startup so post-quit restarts don't stay muted.
                try {
                    globalScope.setTimeout(() => this._resumeAudioContextBestEffort(), 0);
                    globalScope.setTimeout(() => this._resumeAudioContextBestEffort(), 250);
                } catch (_e) {}
                this.running = true;
                this._paused = false;
                this._resumePoisoned = false;
                this._loadedWadSignature = requestedWadSignature;
                this.lastError = "";
                this.frameVersion = 0;
                this.lastFrameVersionDelivered = 0;
                this._startFrameTicker();
                this._installRuntimeErrorGuards();
                this._startPersistentAutoSync();
                this._emitStatus("DOOM runtime started");
                return true;
            } catch (error) {
                this._stopTitleGuard();
                this._removeRuntimeErrorGuards();
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
            this._stopPersistentAutoSync();
            this.running = false;
            this._stopTitleGuard();
            if (this._isWithinRuntimeErrorSuppressionWindow()) {
                // Keep global guards alive briefly so late async quit callbacks
                // (from Emscripten/main-loop teardown) are still intercepted.
                const remainingMs = Math.max(0, (this._suppressRuntimeErrorsUntil || 0) - Date.now());
                this._scheduleRuntimeGuardCleanup(remainingMs + 150);
            } else {
                this._suppressRuntimeErrorsUntil = 0;
                this._removeRuntimeErrorGuards();
            }
            if (this._runtimeReadyResolve) {
                try { this._runtimeReadyResolve(); } catch (_e) {}
                this._runtimeReadyResolve = null;
            }
            if (this.module) {
                try {
                    this._haltRuntimeLoopBestEffort();
                    const sdl2 = this.module.SDL2 || null;
                    // For pause/resume flow, suspend audio context instead of closing it.
                    if (sdl2 && sdl2.audioContext && typeof sdl2.audioContext.suspend === "function") {
                        try {
                            const maybeSuspendPromise = sdl2.audioContext.suspend();
                            if (maybeSuspendPromise && typeof maybeSuspendPromise.catch === "function") {
                                maybeSuspendPromise.catch(() => {});
                            }
                        } catch (_e) {}
                    }
                } catch (_e) {}
            }
            if (this.module && this._mountedIwadPath) {
                try {
                    if (this.module.FS && this.module.FS.analyzePath && this.module.FS.analyzePath(this._mountedIwadPath).exists) {
                        this.module.FS.unlink(this._mountedIwadPath);
                    }
                } catch (_e) {}
            }
            if (this.module && this._mountedPwadPath) {
                try {
                    if (this.module.FS && this.module.FS.analyzePath && this.module.FS.analyzePath(this._mountedPwadPath).exists) {
                        this.module.FS.unlink(this._mountedPwadPath);
                    }
                } catch (_e) {}
            }
            await this._flushPersistentConfigNow();
            this._mountedIwadPath = "";
            this._mountedPwadPath = "";
            this.lastFrameVersionDelivered = 0;
            this._runtimeExitNotified = false;
            // Build-agnostic hard reset so a subsequent start gets a fresh runtime.
            // Use a safe stub Module object to prevent late async callbacks
            // (e.g. audio onaudioprocess) from throwing ReferenceError.
            if (typeof globalScope !== "undefined" && (!globalScope.Module || typeof globalScope.Module !== "object")) {
                globalScope.Module = { SDL2: {} };
            }
            if (this._moduleKind === "factory") {
                this.module = null;
                if (this.outputCanvas && this.outputCanvas.parentNode) {
                    try { this.outputCanvas.parentNode.removeChild(this.outputCanvas); } catch (_e) {}
                }
                this.outputCanvas = null;
                this._moduleKind = "";
                this._loaderPromise = null;
                if (this._loaderScriptEl && this._loaderScriptEl.parentNode) {
                    try { this._loaderScriptEl.parentNode.removeChild(this._loaderScriptEl); } catch (_e) {}
                }
                this._loaderScriptEl = null;
                this._loadedWadSignature = "";
                this._paused = false;
                this._resumePoisoned = false;
                this._persistentMounted = false;
                this._persistSyncInFlight = false;
            } else {
                // Non-modularized runtime stays loaded in-page; reuse on next start via resumeMainLoop.
                this._moduleKind = "global";
                if (globalScope && globalScope.Module && globalScope.Module.FS && globalScope.Module.callMain) {
                    this.module = globalScope.Module;
                }
                if (!this.outputCanvas && this.module && this.module.canvas) {
                    this.outputCanvas = this.module.canvas;
                }
            }
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
                if (globalScope.document) targets.push(globalScope.document);
            }
            try {
                const targets = [];
                if (globalScope) targets.push(globalScope);
                if (this.outputCanvas) targets.push(this.outputCanvas);
                const eventType = type === "up" ? "keyup" : "keydown";
                const code = String(event.code || "");
                const key = String(event.key || "");
                const legacyKeyCodeMap = {
                    Space: 32,
                    ControlLeft: 17,
                    ControlRight: 17,
                    Control: 17,
                    ShiftLeft: 16,
                    ShiftRight: 16,
                    Shift: 16,
                    AltLeft: 18,
                    AltRight: 18,
                    Alt: 18,
                    ArrowLeft: 37,
                    ArrowUp: 38,
                    ArrowRight: 39,
                    ArrowDown: 40
                };
                let legacyKeyCode = Number(event.keyCode || event.which || 0);
                if (!legacyKeyCode) {
                    legacyKeyCode = legacyKeyCodeMap[code] || legacyKeyCodeMap[key] || 0;
                    if (!legacyKeyCode && key && key.length === 1) {
                        legacyKeyCode = key.toUpperCase().charCodeAt(0);
                    }
                }
                const baseInit = {
                    key: event.key,
                    code: event.code,
                    altKey: !!event.altKey,
                    ctrlKey: !!event.ctrlKey,
                    shiftKey: !!event.shiftKey,
                    metaKey: !!event.metaKey,
                    repeat: !!event.repeat,
                    location: Number(event.location || 0),
                    bubbles: true,
                    cancelable: true
                };
                for (const target of targets) {
                    try {
                        const cloned = new KeyboardEvent(eventType, baseInit);
                        // Some runtimes still consult legacy keyCode/which fields.
                        if (legacyKeyCode > 0) {
                            try { Object.defineProperty(cloned, "keyCode", { get: () => legacyKeyCode }); } catch (_e) {}
                            try { Object.defineProperty(cloned, "which", { get: () => legacyKeyCode }); } catch (_e) {}
                        }
                        target.dispatchEvent(cloned);
                    } catch (_e) {}
                }
                return true;
            } catch (_e) {
                return false;
            }
        }

        canResume() {
            return !!(
                this._paused &&
                this.module &&
                typeof this.module.resumeMainLoop === "function" &&
                !this._resumePoisoned &&
                this._hasUsableAudioContextForResume() &&
                this._loadedWadSignature
            );
        }
    }

    globalScope.JigsawDoomRuntimeAdapter = DoomRuntimeAdapter;
})(window);

