"use strict";

/**
 * Runtime modules manifest.
 *
 * Module author workflow:
 * - Add/edit entries in MODULES below.
 * - Keep module-specific logic/assets inside src/modules/<module-id>/.
 */
(function initRuntimeModuleManifest(globalScope) {
    function resolveUrl(relativePath) {
        try {
            return new URL(relativePath, (typeof location !== "undefined" ? location.href : undefined)).toString();
        } catch (_e) {
            return relativePath;
        }
    }

    /**
     * @type {Array<{
     *   id: string,
     *   label: string,
     *   secretCode: string,
     *   scriptUrls?: string[],
     *   adapterGlobal: string,
     *   stopButtonLabel?: string,
     *   priority?: number,
     *   keySubscriptions: {
     *     forwardCodes: string[],
     *     preventDefault?: boolean,
     *     stopPropagation?: boolean,
     *     blockFunctionKeys?: boolean,
     *     allowMeta?: boolean,
     *     allowCtrlAlt?: boolean
     *   },
     *   activation?: {
     *     requiresFile?: boolean,
     *     files?: Array<{
     *       id: string,
     *       role?: string,
     *       label?: string,
     *       description?: string,
     *       required?: boolean,
     *       accept?: string,
     *       promptText?: string
     *     }>,
     *     filePrompt?: { accept?: string, id?: string }
     *   },
     *   config?: Object
     * }>}
     */
    const MODULES = [
        {
            id: "doom",
            label: "DOOM",
            secretCode: "hurtmeplenty",
            adapterGlobal: "JigsawDoomModuleAdapter",
            scriptUrls: [
                resolveUrl("./src/modules/doom/DoomRuntimeAdapter.js"),
                resolveUrl("./src/modules/doom/DoomModuleAdapter.js"),
                resolveUrl("./src/modules/doom/doomgeneric.js")
            ],
            stopButtonLabel: "Stop DOOM",
            priority: 100,
            keySubscriptions: {
                forwardCodes: [
                    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
                    "KeyW", "KeyA", "KeyS", "KeyD",
                    "Space",
                    "ControlLeft", "ControlRight",
                    "ShiftLeft", "ShiftRight",
                    "AltLeft", "AltRight",
                    "Enter", "Tab", "Escape"
                ],
                preventDefault: true,
                stopPropagation: true,
                blockFunctionKeys: true,
                allowMeta: false,
                allowCtrlAlt: true
            },
            activation: {
                requiresFile: true,
                files: [
                    {
                        id: "runtimeModuleFileInput-doom-iwad",
                        role: "iwad",
                        label: "IWAD",
                        description: "Base game data required to boot DOOM (for example, DOOM1.WAD or DOOM2.WAD).",
                        required: true,
                        accept: ".wad,application/octet-stream",
                        promptText: "Select an IWAD file to boot DOOM (for example, DOOM1.WAD or DOOM2.WAD)."
                    },
                    {
                        id: "runtimeModuleFileInput-doom-pwad",
                        role: "pwad",
                        label: "PWAD (optional mod/patch)",
                        description: "Optional patch/mod WAD loaded on top of the IWAD.",
                        required: false,
                        accept: ".wad,application/octet-stream",
                        promptText: "Optional: select a PWAD file to load as a patch/mod. Click Cancel to continue without a PWAD."
                    }
                ]
            },
            config: {
                loaderUrl: resolveUrl("./src/modules/doom/doomgeneric.js"),
                wasmUrl: resolveUrl("./src/modules/doom/doomgeneric.wasm"),
                factoryName: "createDoomGenericModule",
                canvasWidth: 320,
                canvasHeight: 200,
                launchArgs: []
            }
        },
        {
            id: "screensaver",
            label: "Screensaver",
            secretCode: "screensaver",
            adapterGlobal: "JigsawScreensaverModuleAdapter",
            scriptUrls: [
                resolveUrl("./src/modules/screensaver/ScreensaverRuntimeAdapter.js"),
                resolveUrl("./src/modules/screensaver/ScreensaverModuleAdapter.js")
            ],
            stopButtonLabel: "Stop Screensaver",
            priority: 50,
            keySubscriptions: {
                forwardCodes: ["Escape"],
                preventDefault: true,
                stopPropagation: true,
                blockFunctionKeys: true,
                allowMeta: false,
                allowCtrlAlt: false
            },
            config: {
                canvasWidth: 640,
                canvasHeight: 360,
                logoSvgUrl: resolveUrl("./src/modules/screensaver/color-icon.svg"),
                speedPxPerSec: 170
            }
        }
    ];

    globalScope.JigsawRuntimeModulesManifest = MODULES;
})(window);
