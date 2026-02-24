"use strict";

(function initModuleRegistry(globalScope) {
    class ModuleRegistry {
        constructor(options = {}) {
            this.logger = typeof options.logger === "function" ? options.logger : () => {};
            this._entries = [];
            this._idMap = new Map();
        }

        _normalizeActivation(moduleId, rawActivation) {
            const activation = Object.assign({
                requiresFile: false,
                filePrompt: null,
                filePrompts: [],
                files: []
            }, rawActivation || {});
            const normalizedFiles = [];
            const sourceFiles = Array.isArray(activation.files) ? activation.files : [];
            const sourcePrompts = Array.isArray(activation.filePrompts) ? activation.filePrompts : [];
            if (sourceFiles.length > 0) {
                for (let i = 0; i < sourceFiles.length; i++) {
                    const slot = sourceFiles[i] || {};
                    const slotId = String(slot.id || "").trim();
                    const role = String(slot.role || slotId || ("file" + (i + 1))).trim();
                    normalizedFiles.push({
                        id: slotId || ("runtimeModuleFileInput-" + moduleId + "-" + role),
                        role: role,
                        label: String(slot.label || role.toUpperCase()).trim(),
                        description: String(slot.description || slot.promptText || "").trim(),
                        required: slot.required !== false,
                        accept: String(slot.accept || "*/*").trim(),
                        promptText: String(slot.promptText || "").trim()
                    });
                }
            } else if (sourcePrompts.length > 0) {
                for (let i = 0; i < sourcePrompts.length; i++) {
                    const prompt = sourcePrompts[i] || {};
                    const role = String(prompt.role || ("file" + (i + 1))).trim();
                    normalizedFiles.push({
                        id: String(prompt.id || ("runtimeModuleFileInput-" + moduleId + "-" + role)).trim(),
                        role: role,
                        label: String(prompt.label || role.toUpperCase()).trim(),
                        description: String(prompt.description || prompt.promptText || "").trim(),
                        required: prompt.required !== false,
                        accept: String(prompt.accept || "*/*").trim(),
                        promptText: String(prompt.promptText || "").trim()
                    });
                }
            } else if (activation.filePrompt && typeof activation.filePrompt === "object") {
                const prompt = activation.filePrompt;
                normalizedFiles.push({
                    id: String(prompt.id || ("runtimeModuleFileInput-" + moduleId + "-file1")).trim(),
                    role: String(prompt.role || "file").trim(),
                    label: String(prompt.label || "Required file").trim(),
                    description: String(prompt.description || prompt.promptText || "").trim(),
                    required: prompt.required !== false,
                    accept: String(prompt.accept || "*/*").trim(),
                    promptText: String(prompt.promptText || "").trim()
                });
            } else if (activation.requiresFile) {
                normalizedFiles.push({
                    id: "runtimeModuleFileInput-" + moduleId + "-file1",
                    role: "file",
                    label: "Required file",
                    description: "",
                    required: true,
                    accept: "*/*",
                    promptText: ""
                });
            }
            return {
                requiresFile: normalizedFiles.length > 0 || !!activation.requiresFile,
                filePrompt: activation.filePrompt || null,
                filePrompts: sourcePrompts.slice(),
                files: normalizedFiles
            };
        }

        _normalizeEntry(raw) {
            if (!raw || typeof raw !== "object") return null;
            const id = String(raw.id || "").trim();
            const label = String(raw.label || id || "module").trim();
            const secretCode = String(raw.secretCode || "").toLowerCase().trim();
            const adapterGlobal = String(raw.adapterGlobal || "").trim();
            if (!id || !secretCode || !adapterGlobal) return null;
            const keySubscriptions = Object.assign({
                forwardCodes: [],
                preventDefault: true,
                stopPropagation: true,
                blockFunctionKeys: true,
                allowMeta: false,
                allowCtrlAlt: false
            }, raw.keySubscriptions || {});
            keySubscriptions.forwardCodes = Array.isArray(keySubscriptions.forwardCodes)
                ? keySubscriptions.forwardCodes.map((x) => String(x || "").trim()).filter(Boolean)
                : [];
            return {
                id: id,
                label: label,
                secretCode: secretCode,
                scriptUrls: Array.isArray(raw.scriptUrls) ? raw.scriptUrls.slice() : [],
                adapterGlobal: adapterGlobal,
                stopButtonLabel: String(raw.stopButtonLabel || ("Stop " + label)),
                priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 0,
                keySubscriptions: keySubscriptions,
                activation: this._normalizeActivation(id, raw.activation || null),
                config: Object.assign({}, raw.config || {})
            };
        }

        registerAll(manifestEntries) {
            this._entries = [];
            this._idMap.clear();
            const list = Array.isArray(manifestEntries) ? manifestEntries : [];
            for (const raw of list) {
                const next = this._normalizeEntry(raw);
                if (!next) continue;
                if (this._idMap.has(next.id)) {
                    this.logger("duplicate module id skipped: " + next.id, "warn");
                    continue;
                }
                this._entries.push(next);
                this._idMap.set(next.id, next);
            }
            this._entries.sort((a, b) => {
                if (b.priority !== a.priority) return b.priority - a.priority;
                return b.secretCode.length - a.secretCode.length;
            });
            return this.getAll();
        }

        getAll() {
            return this._entries.slice();
        }

        getById(moduleId) {
            const id = String(moduleId || "").trim();
            if (!id) return null;
            return this._idMap.get(id) || null;
        }
    }

    globalScope.JigsawModuleRegistry = ModuleRegistry;
})(window);

