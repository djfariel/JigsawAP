"use strict";

/**
 * Runtime module contract for canvas-backed integrations.
 *
 * Module authors should only need to touch:
 * 1) src/modules/manifest.js
 * 2) files inside their module folder
 *
 * This file documents the expected shape of module manifest entries and
 * module adapter implementations consumed by the runtime orchestrator.
 */
(function initRuntimeModuleContract(globalScope) {
    /**
     * @typedef {"down"|"up"} JigsawModuleKeyEventType
     */

    /**
     * Declares which keys the active module receives and what the host should
     * do with those key events while the module is active.
     *
     * @typedef {Object} JigsawRuntimeModuleKeySubscriptions
     * @property {string[]} forwardCodes KeyboardEvent.code values forwarded to the module.
     * @property {boolean} [preventDefault=true] Prevent default browser behavior for forwarded keys.
     * @property {boolean} [stopPropagation=true] Stop propagation for forwarded keys.
     * @property {boolean} [blockFunctionKeys=true] Block function keys while module is active.
     * @property {boolean} [allowMeta=false] If false, ignore events with metaKey=true.
     * @property {boolean} [allowCtrlAlt=false] If false, ignore non-modifier events with ctrl/alt.
     */

    /**
     * Optional activation prompt for modules that need user-provided files.
     *
     * @typedef {Object} JigsawRuntimeModuleFilePrompt
     * @property {string} [accept] Input accept filter, e.g. ".wad,application/octet-stream".
     * @property {string} [id] Optional DOM id for the hidden input element.
     * @property {string} [role] Optional role name when requesting multiple files (e.g. "iwad", "pwad").
     * @property {boolean} [required=true] If false, user may cancel this specific prompt.
     * @property {string} [promptText] Optional text shown before opening the file picker.
     */

    /**
     * Declarative file slot used by the module activation wizard.
     *
     * @typedef {Object} JigsawRuntimeModuleFileSlot
     * @property {string} id Stable slot id used for UI/input bookkeeping.
     * @property {string} [role] Payload key passed to adapter.start(...).
     * @property {string} [label] Human-readable slot label shown to users.
     * @property {string} [description] Optional helper text shown under the label.
     * @property {boolean} [required=true] If false, slot may be left empty.
     * @property {string} [accept] Input accept filter.
     * @property {string} [promptText] Optional short chooser hint.
     */

    /**
     * @typedef {Object} JigsawRuntimeModuleActivationConfig
     * @property {boolean} [requiresFile] If true, host requests a file before start().
     * @property {JigsawRuntimeModuleFilePrompt} [filePrompt] Hidden file input config.
     * @property {JigsawRuntimeModuleFilePrompt[]} [filePrompts] Ordered list of prompts for multi-file activation.
     * @property {JigsawRuntimeModuleFileSlot[]} [files] Ordered file slots for the activation wizard.
     */

    /**
     * Manifest entry consumed by the runtime module registry.
     *
     * @typedef {Object} JigsawRuntimeModuleManifestEntry
     * @property {string} id Stable unique module id.
     * @property {string} label User-facing label.
     * @property {string} secretCode Lowercase activation sequence typed during gameplay.
     * @property {string[]} [scriptUrls] Lazy-loaded scripts needed for the module runtime.
     * @property {string} adapterGlobal Window global name that resolves to module adapter constructor.
     * @property {string} [stopButtonLabel] Label for the stop button while module is active.
     * @property {number} [priority=0] Sort priority when multiple secret codes overlap.
     * @property {JigsawRuntimeModuleKeySubscriptions} keySubscriptions Key routing config.
     * @property {JigsawRuntimeModuleActivationConfig} [activation] Activation-time UX config.
     * @property {Object<string, unknown>} [config] Adapter constructor config blob.
     */

    /**
     * Host services passed to each module adapter.
     *
     * @typedef {Object} JigsawRuntimeModuleContext
     * @property {Object|null} rendererFacade Renderer facade instance.
     * @property {Object|null} mediaBindings Media bindings API.
     * @property {Object} ui Host UI helpers.
     * @property {(message:string, level?:"info"|"warn"|"error") => void} logger Logging callback.
     * @property {(options?:JigsawRuntimeModuleFilePrompt) => Promise<File|null>} requestFile File chooser helper.
     * @property {(options:{moduleId:string,moduleLabel:string,files:JigsawRuntimeModuleFileSlot[]}) => Promise<Object<string, File>|null>} requestActivationFiles Wizard-based file chooser helper.
     * @property {(payload:{reason?:string,moduleId?:string,detail?:Object|null}) => Promise<void>} requestStop Ask host to stop module mode.
     */

    /**
     * Adapter interface each module constructor should implement.
     *
     * @typedef {Object} JigsawRuntimeModuleAdapter
     * @property {(context:JigsawRuntimeModuleContext) => (void|Promise<void>)} [init]
     * @property {(payload?:Object|null) => Promise<boolean>|boolean} start
     * @property {(reason?:string) => Promise<void>|void} stop
     * @property {() => boolean} isRunning
     * @property {() => (HTMLCanvasElement|HTMLVideoElement|HTMLImageElement|null)} getFrameSource
     * @property {(nowMs:number) => boolean} updateFrameClock
     * @property {(event:KeyboardEvent, type:JigsawModuleKeyEventType) => boolean} [onKeyEvent]
     * @property {(event:KeyboardEvent, type:JigsawModuleKeyEventType) => boolean} [sendKeyEvent]
     * @property {() => boolean} [canResume]
     */

    /**
     * Marker export used by tooling and runtime checks.
     */
    globalScope.JigsawRuntimeModuleContract = Object.freeze({
        version: 1,
        manifestShape: "JigsawRuntimeModuleManifestEntry",
        adapterShape: "JigsawRuntimeModuleAdapter"
    });
})(window);

