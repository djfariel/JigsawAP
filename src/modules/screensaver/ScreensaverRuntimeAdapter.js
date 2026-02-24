"use strict";

(function initScreensaverRuntimeAdapter(globalScope) {
    const SVG_CLASS_RING_ORDER = Object.freeze(["st0", "st1", "st3", "st5", "st4", "st2"]);
    const SVG_RING_COLORS = Object.freeze([
        "#c97682", // top
        "#75c275", // top-right
        "#ca94c2", // bottom-right
        "#d9a07d", // bottom
        "#767ebd", // bottom-left
        "#eee391"  // top-left
    ]);

    const DEFAULTS = Object.freeze({
        canvasWidth: 640,
        canvasHeight: 360,
        logoSvgUrl: "./src/modules/screensaver/color-icon.svg",
        speedPxPerSec: 170,
        minDeltaMs: 16,
        maxDeltaMs: 50,
        backgroundColor: "#000000",
        colors: SVG_RING_COLORS
    });

    class ScreensaverRuntimeAdapter {
        constructor(options = {}) {
            this.options = Object.assign({}, DEFAULTS, options || {});
            this.canvas = null;
            this.ctx = null;
            this.running = false;
            this.lastNowMs = 0;
            this.logo = null;
            this.colorIndex = 0;
            this.svgTemplate = "";
            this.svgImageByRotation = new Map();
            this.svgClassColors = new Map();
            this.svgImage = null;
        }

        _ensureCanvas() {
            if (this.canvas && this.ctx) return;
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(64, Number(this.options.canvasWidth) || DEFAULTS.canvasWidth);
            canvas.height = Math.max(64, Number(this.options.canvasHeight) || DEFAULTS.canvasHeight);
            this.canvas = canvas;
            this.ctx = canvas.getContext("2d");
            this._resetLogoState();
            this._drawFrame();
        }

        _resetLogoState() {
            const width = this.canvas ? this.canvas.width : DEFAULTS.canvasWidth;
            const height = this.canvas ? this.canvas.height : DEFAULTS.canvasHeight;
            const logoSize = Math.max(128, Math.round(Math.min(width, height) * 0.42));
            const speed = Math.max(40, Number(this.options.speedPxPerSec) || DEFAULTS.speedPxPerSec);

            this.logo = {
                x: Math.max(0, Math.round((width - logoSize) * 0.5)),
                y: Math.max(0, Math.round((height - logoSize) * 0.5)),
                w: logoSize,
                h: logoSize,
                vx: speed,
                vy: speed * 0.8
            };
            this.colorIndex = 0;
        }

        _resolveSvgUrl() {
            const rawUrl = String(this.options.logoSvgUrl || DEFAULTS.logoSvgUrl).trim();
            if (!rawUrl) return "";
            try {
                return new URL(rawUrl, globalScope.location ? globalScope.location.href : undefined).toString();
            } catch (_e) {
                return rawUrl;
            }
        }

        _getPalette() {
            const colors = Array.isArray(this.options.colors) ? this.options.colors : [];
            if (colors.length >= SVG_CLASS_RING_ORDER.length) {
                return colors.slice(0, SVG_CLASS_RING_ORDER.length).map((v) => String(v).toLowerCase());
            }
            return SVG_RING_COLORS.slice();
        }

        async _loadSvgTemplate() {
            if (this.svgTemplate) return this.svgTemplate;
            const url = this._resolveSvgUrl();
            if (!url) throw new Error("Screensaver SVG URL is missing");
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error("Failed to load screensaver SVG");
            }
            const svgText = await response.text();
            const classFillRegex = /\.([a-zA-Z_][\w-]*)\s*\{\s*fill\s*:\s*(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}))\s*;?\s*\}/g;
            let match;
            this.svgTemplate = svgText;
            while ((match = classFillRegex.exec(svgText)) !== null) {
                const className = String(match[1] || "").trim();
                const classColor = String(match[2] || "").toLowerCase();
                if (!className || !classColor) continue;
                this.svgClassColors.set(className, classColor);
            }
            for (let i = 0; i < SVG_CLASS_RING_ORDER.length; i++) {
                const className = SVG_CLASS_RING_ORDER[i];
                if (!this.svgClassColors.has(className)) {
                    throw new Error("color-icon.svg is missing class '" + className + "'");
                }
            }
            return this.svgTemplate;
        }

        _getRotatedColors(rotation = 0) {
            const palette = this._getPalette();
            if (!palette.length) return SVG_RING_COLORS.slice();
            const offset = ((rotation % palette.length) + palette.length) % palette.length;
            const out = [];
            for (let i = 0; i < palette.length; i++) {
                out.push(palette[(i + offset) % palette.length]);
            }
            return out;
        }

        _renderSvgWithRotatedColors(rotation = 0) {
            if (!this.svgTemplate) return "";
            const rotated = this._getRotatedColors(rotation);
            let out = this.svgTemplate;
            for (let i = 0; i < SVG_CLASS_RING_ORDER.length; i++) {
                const className = SVG_CLASS_RING_ORDER[i];
                const src = this.svgClassColors.get(className);
                const target = rotated[i] || src;
                if (!src) continue;
                const token = "__SVG_CLASS_COLOR_TOKEN_" + i + "__";
                const classRegex = new RegExp("(\\." + className + "\\s*\\{[^}]*fill\\s*:\\s*)" + src.replace("#", "\\#"), "gi");
                out = out.replace(classRegex, "$1" + token);
                out = out.replace(new RegExp(token, "g"), target);
            }
            return out;
        }

        async _createImageFromSvg(svgText) {
            return await new Promise((resolve, reject) => {
                const img = new Image();
                let blobUrl = "";
                try {
                    const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
                    blobUrl = URL.createObjectURL(blob);
                    img.src = blobUrl;
                } catch (_e) {
                    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
                }
                img.onload = () => {
                    if (blobUrl) {
                        try { URL.revokeObjectURL(blobUrl); } catch (_e) {}
                    }
                    resolve(img);
                };
                img.onerror = () => {
                    if (blobUrl) {
                        try { URL.revokeObjectURL(blobUrl); } catch (_e) {}
                    }
                    reject(new Error("Failed to decode screensaver SVG image"));
                };
            });
        }

        async _ensureSvgImage(rotation = 0) {
            const key = String(rotation);
            if (this.svgImageByRotation.has(key)) return this.svgImageByRotation.get(key);
            await this._loadSvgTemplate();
            const svgWithColors = this._renderSvgWithRotatedColors(rotation);
            const image = await this._createImageFromSvg(svgWithColors);
            this.svgImageByRotation.set(key, image);
            return image;
        }

        _advanceRotation() {
            this.colorIndex = (this.colorIndex + 1) % SVG_CLASS_RING_ORDER.length;
        }

        _drawFrame() {
            if (!this.canvas || !this.ctx || !this.logo) return;
            const ctx = this.ctx;
            const logo = this.logo;
            ctx.fillStyle = this.options.backgroundColor || DEFAULTS.backgroundColor;
            ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            if (this.svgImage) {
                ctx.drawImage(this.svgImage, logo.x, logo.y, logo.w, logo.h);
            }
        }

        async start(_payload) {
            this._ensureCanvas();
            this.svgImage = await this._ensureSvgImage(this.colorIndex);
            this.running = true;
            this.lastNowMs = 0;
            this._drawFrame();
            return true;
        }

        stop(_reason = "manual") {
            this.running = false;
        }

        isRunning() {
            return !!this.running;
        }

        getFrameSource() {
            this._ensureCanvas();
            return this.canvas;
        }

        updateFrameClock(nowMs) {
            if (!this.running || !this.canvas || !this.logo) return false;
            const now = Number(nowMs) || Date.now();
            const minDelta = Math.max(1, Number(this.options.minDeltaMs) || DEFAULTS.minDeltaMs);
            const maxDelta = Math.max(minDelta, Number(this.options.maxDeltaMs) || DEFAULTS.maxDeltaMs);
            let deltaMs = this.lastNowMs > 0 ? (now - this.lastNowMs) : minDelta;
            this.lastNowMs = now;
            if (!isFinite(deltaMs) || deltaMs <= 0) deltaMs = minDelta;
            if (deltaMs > maxDelta) deltaMs = maxDelta;
            const dt = deltaMs / 1000;

            const logo = this.logo;
            const maxX = Math.max(0, this.canvas.width - logo.w);
            const maxY = Math.max(0, this.canvas.height - logo.h);
            let bounced = false;

            logo.x += logo.vx * dt;
            logo.y += logo.vy * dt;

            if (logo.x <= 0) {
                logo.x = 0;
                logo.vx = Math.abs(logo.vx);
                bounced = true;
            } else if (logo.x >= maxX) {
                logo.x = maxX;
                logo.vx = -Math.abs(logo.vx);
                bounced = true;
            }

            if (logo.y <= 0) {
                logo.y = 0;
                logo.vy = Math.abs(logo.vy);
                bounced = true;
            } else if (logo.y >= maxY) {
                logo.y = maxY;
                logo.vy = -Math.abs(logo.vy);
                bounced = true;
            }

            if (bounced) {
                this._advanceRotation();
                this._ensureSvgImage(this.colorIndex)
                    .then((image) => {
                        this.svgImage = image;
                    })
                    .catch(() => {});
            }
            this._drawFrame();
            return true;
        }
    }

    globalScope.JigsawScreensaverRuntimeAdapter = ScreensaverRuntimeAdapter;
})(window);
