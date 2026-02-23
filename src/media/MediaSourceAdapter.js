"use strict";

(function initMediaSourceAdapter(globalScope) {
    class MediaSourceAdapter {
        constructor() {
            this.mode = "image";
            this.image = null;
            this.video = null;
            this.stream = null;
            this.ready = false;
            this.failureReason = "";
            this.lastFrameAt = 0;
            this.lastVideoTime = -1;
            this.frameIntervalMs = 33;
            this.gifFrameCanvas = null;
            this.gifDecoder = null;
            this.gifFrames = [];
            this.gifFrameIndex = 0;
            this.gifNextFrameAt = 0;
            this._gifFrameVersion = 0;
            this._gifFrameDeliveredVersion = 0;
            this.doomAdapter = null;
            this.doomCanvas = null;
            this.doomFrameVersion = 0;
            this.doomFrameDeliveredVersion = 0;
            this._stateBeforeDoom = null;
        }

        setImageSource(img, kind = "image") {
            this.clearDoomSource(false);
            this._stopGifPlayback();
            this.mode = kind === "gif" ? "gif" : "image";
            this.image = img || null;
            this.ready = !!(img && img.complete);
            this.failureReason = this.ready ? "" : "not-ready";
            this.lastFrameAt = 0;
        }

        setVideoElement(videoEl, kind = "video") {
            this.clearDoomSource(false);
            this._stopGifPlayback();
            this.mode = (kind === "camera" || kind === "display") ? kind : "video";
            this.video = videoEl || null;
            this.ready = !!(videoEl && videoEl.readyState >= 2);
            this.failureReason = this.ready ? "" : "not-ready";
            this.lastVideoTime = this.video ? this.video.currentTime : -1;
            this.lastFrameAt = 0;
        }

        async setCameraStream(constraints = { video: true, audio: false }) {
            this.clearDoomSource(false);
            this._stopGifPlayback();
            this.mode = "camera";
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                this.failureReason = "camera-unavailable";
                throw new Error("Camera API not available");
            }
            this.stream = await navigator.mediaDevices.getUserMedia(constraints);
            if (!this.video) {
                this.video = document.createElement("video");
                this.video.muted = true;
                this.video.playsInline = true;
                this.video.autoplay = true;
            }
            this.video.srcObject = this.stream;
            await this.video.play();
            this.ready = true;
            this.failureReason = "";
            this.lastVideoTime = this.video.currentTime;
            this.lastFrameAt = 0;
        }

        async setDisplayStream(stream) {
            this.clearDoomSource(false);
            this._stopGifPlayback();
            this.mode = "display";
            if (!stream || !stream.getTracks) {
                this.failureReason = "display-stream-invalid";
                throw new Error("Invalid display stream");
            }
            this.stream = stream;
            if (!this.video) {
                this.video = document.createElement("video");
                this.video.muted = true;
                this.video.playsInline = true;
                this.video.autoplay = true;
            }
            this.video.srcObject = this.stream;
            await this.video.play();
            this.ready = true;
            this.failureReason = "";
            this.lastVideoTime = this.video.currentTime;
            this.lastFrameAt = 0;
        }

        async startGifPlayback(url) {
            this.clearDoomSource(false);
            this._stopGifPlayback();
            this.mode = "gif-decoded";
            this.ready = false;
            this.failureReason = "";
            this.lastFrameAt = 0;
            this._gifFrameVersion = 0;
            this._gifFrameDeliveredVersion = 0;
            if (!url) {
                this.failureReason = "not-ready";
                return false;
            }
            if (typeof globalScope.ImageDecoder !== "function") {
                this.failureReason = "gif-decoder-unavailable";
                return false;
            }
            const canvas = document.createElement("canvas");
            canvas.width = 1;
            canvas.height = 1;
            this.gifFrameCanvas = canvas;
            try {
                const response = await fetch(url);
                if (!response.ok) {
                    this.failureReason = "gif-fetch-failed";
                    return false;
                }
                const blob = await response.blob();
                const buffer = await blob.arrayBuffer();
                const mimeType = (blob.type && blob.type.includes("gif")) ? blob.type : "image/gif";
                this.gifDecoder = new globalScope.ImageDecoder({ data: buffer, type: mimeType });
                if (this.gifDecoder.tracks && this.gifDecoder.tracks.ready) {
                    await this.gifDecoder.tracks.ready;
                }
                const track = this.gifDecoder.tracks ? this.gifDecoder.tracks.selectedTrack : null;
                const frameCount = (track && track.frameCount) ? track.frameCount : 1;
                if (frameCount < 1) {
                    this.failureReason = "gif-decode-failed";
                    return false;
                }
                this.gifFrames = [];
                for (let i = 0; i < frameCount; i++) {
                    const decoded = await this.gifDecoder.decode({ frameIndex: i });
                    const image = decoded && decoded.image ? decoded.image : null;
                    if (!image) continue;
                    let durationMs = this._gifDurationToMs(image.duration);
                    if (!durationMs || !isFinite(durationMs) || durationMs < 10) durationMs = 100;
                    this.gifFrames.push({ image: image, durationMs: durationMs });
                }
                if (!this.gifFrames.length) {
                    this.failureReason = "gif-decode-failed";
                    return false;
                }
                const first = this.gifFrames[0].image;
                canvas.width = Math.max(1, first.displayWidth || first.codedWidth || 1);
                canvas.height = Math.max(1, first.displayHeight || first.codedHeight || 1);
                this.gifFrameIndex = 0;
                this._presentGifFrame(0, (globalScope.performance && globalScope.performance.now) ? globalScope.performance.now() : Date.now());
                return true;
            } catch (e) {
                const msg = (e && e.message) ? String(e.message).toLowerCase() : "";
                this.failureReason = msg.includes("cors") || msg.includes("origin") ? "cors" : "gif-decode-failed";
                this.ready = false;
                return false;
            }
        }

        stop() {
            this.clearDoomSource(false);
            this._stopGifPlayback();
            if (this.stream) {
                this.stream.getTracks().forEach((t) => t.stop());
            }
            this.stream = null;
            this.ready = false;
            this.failureReason = "stopped";
        }

        setDoomSource(adapter, sourceCanvas = null) {
            if (!adapter) {
                this.failureReason = "doom-adapter-missing";
                this.ready = false;
                return false;
            }
            if (!this._stateBeforeDoom) this._stateBeforeDoom = this._createSnapshot();
            this.doomAdapter = adapter;
            this.doomCanvas = sourceCanvas || (adapter.getFrameSource ? adapter.getFrameSource() : null);
            this.mode = "doom";
            this.ready = !!this.doomCanvas;
            this.failureReason = this.ready ? "" : "doom-frame-not-ready";
            this.lastFrameAt = 0;
            this.doomFrameVersion = 0;
            this.doomFrameDeliveredVersion = 0;
            return this.ready;
        }

        clearDoomSource(restorePrevious = true) {
            if (this.mode !== "doom" && !this.doomAdapter && !this._stateBeforeDoom) return false;
            const snapshot = this._stateBeforeDoom;
            this.doomAdapter = null;
            this.doomCanvas = null;
            this.doomFrameVersion = 0;
            this.doomFrameDeliveredVersion = 0;
            this._stateBeforeDoom = null;
            if (restorePrevious && snapshot) {
                this._restoreSnapshot(snapshot);
                return true;
            }
            if (!restorePrevious) {
                this.mode = "image";
                return true;
            }
            this.ready = false;
            this.failureReason = "stopped";
            return true;
        }

        isDoomActive() {
            return this.mode === "doom" && !!this.doomAdapter;
        }

        getFrameSource() {
            if (!this.ready) return null;
            if (this.mode === "doom") return this.doomCanvas || (this.doomAdapter && this.doomAdapter.getFrameSource ? this.doomAdapter.getFrameSource() : null);
            if (this.mode === "gif-decoded") return this.gifFrameCanvas;
            if (this.mode === "image" || this.mode === "gif") return this.image;
            if (this.mode === "video" || this.mode === "camera" || this.mode === "display") return this.video;
            return this.image || this.video;
        }

        updateFrameClock(nowMs) {
            if (!this.ready && (this.mode === "image" || this.mode === "gif") && this.image && this.image.complete) {
                this.ready = true;
                this.failureReason = "";
            }
            if (this.mode === "doom") {
                if (!this.doomAdapter || !this.doomAdapter.isRunning || !this.doomAdapter.isRunning()) {
                    this.ready = false;
                    this.failureReason = "doom-stopped";
                    return false;
                }
                if (this.doomAdapter.updateFrameClock && this.doomAdapter.updateFrameClock(nowMs)) {
                    this.doomFrameVersion++;
                }
                const latestCanvas = this.doomAdapter.getFrameSource ? this.doomAdapter.getFrameSource() : null;
                if (latestCanvas) {
                    this.doomCanvas = latestCanvas;
                    this.ready = true;
                } else if (!this.doomCanvas) {
                    this.ready = false;
                    this.failureReason = "doom-frame-not-ready";
                    return false;
                }
                if (this.doomFrameVersion > this.doomFrameDeliveredVersion) {
                    this.doomFrameDeliveredVersion = this.doomFrameVersion;
                    this.lastFrameAt = nowMs || 0;
                    this.failureReason = "";
                    return true;
                }
                return false;
            }
            if (!this.ready) return false;
            if (this.mode === "image") return false;
            if (this.mode === "gif-decoded") {
                if (this._gifFrameVersion > this._gifFrameDeliveredVersion) {
                    this._gifFrameDeliveredVersion = this._gifFrameVersion;
                    return true;
                }
                if (!this.gifFrames.length) return false;
                if (!this.gifNextFrameAt || nowMs >= this.gifNextFrameAt) {
                    const next = (this.gifFrameIndex + 1) % this.gifFrames.length;
                    this._presentGifFrame(next, nowMs);
                    this._gifFrameDeliveredVersion = this._gifFrameVersion;
                    return true;
                }
                return false;
            }

            if (this.mode === "gif") {
                if (!this.lastFrameAt || (nowMs - this.lastFrameAt) >= this.frameIntervalMs) {
                    this.lastFrameAt = nowMs;
                    return true;
                }
                return false;
            }

            if (this.mode === "video" || this.mode === "camera" || this.mode === "display") {
                const v = this.video;
                if (!v || v.readyState < 2) {
                    this.failureReason = "not-ready";
                    return false;
                }
                const changed = this.lastVideoTime < 0 || v.currentTime !== this.lastVideoTime;
                if (changed) {
                    this.lastVideoTime = v.currentTime;
                    this.lastFrameAt = nowMs;
                    this.failureReason = "";
                    return true;
                }
                return false;
            }

            return false;
        }

        getStatus() {
            return {
                kind: this.mode,
                ready: this.ready,
                failureReason: this.failureReason || "",
                lastFrameAt: this.lastFrameAt || 0,
                frameVersion: this._gifFrameVersion || 0,
                frameCount: this.gifFrames.length || 0,
                doomActive: this.isDoomActive(),
                doomFrameVersion: this.doomFrameVersion || 0
            };
        }

        _stopGifPlayback() {
            if (this.gifFrames && this.gifFrames.length) {
                this.gifFrames.forEach((f) => {
                    if (f && f.image && typeof f.image.close === "function") {
                        try { f.image.close(); } catch (_e) {}
                    }
                });
            }
            this.gifFrames = [];
            if (this.gifDecoder && typeof this.gifDecoder.close === "function") {
                try { this.gifDecoder.close(); } catch (_e) {}
            }
            this.gifDecoder = null;
            this.gifFrameCanvas = null;
            this.gifFrameIndex = 0;
            this.gifNextFrameAt = 0;
            this._gifFrameVersion = 0;
            this._gifFrameDeliveredVersion = 0;
            if (this.mode === "gif-decoded") {
                this.ready = false;
            }
        }

        _gifDurationToMs(duration) {
            if (duration == null) return 100;
            const d = Number(duration);
            if (!isFinite(d) || d <= 0) return 100;
            return d > 1000 ? (d / 1000) : d;
        }

        _presentGifFrame(index, nowMs) {
            if (!this.gifFrameCanvas || !this.gifFrames.length) return;
            const safeIndex = ((index % this.gifFrames.length) + this.gifFrames.length) % this.gifFrames.length;
            const frame = this.gifFrames[safeIndex];
            const ctx = this.gifFrameCanvas.getContext("2d");
            if (!ctx || !frame || !frame.image) return;
            ctx.clearRect(0, 0, this.gifFrameCanvas.width, this.gifFrameCanvas.height);
            ctx.drawImage(frame.image, 0, 0, this.gifFrameCanvas.width, this.gifFrameCanvas.height);
            this.gifFrameIndex = safeIndex;
            const durationMs = frame.durationMs || 100;
            this.gifNextFrameAt = (nowMs || 0) + durationMs;
            this._gifFrameVersion++;
            this.lastFrameAt = nowMs || 0;
            this.ready = true;
            this.failureReason = "";
        }

        _createSnapshot() {
            return {
                mode: this.mode,
                image: this.image,
                video: this.video,
                stream: this.stream,
                ready: this.ready,
                failureReason: this.failureReason,
                lastFrameAt: this.lastFrameAt,
                lastVideoTime: this.lastVideoTime,
                frameIntervalMs: this.frameIntervalMs,
                gifFrameCanvas: this.gifFrameCanvas,
                gifDecoder: this.gifDecoder,
                gifFrames: this.gifFrames,
                gifFrameIndex: this.gifFrameIndex,
                gifNextFrameAt: this.gifNextFrameAt,
                gifFrameVersion: this._gifFrameVersion,
                gifFrameDeliveredVersion: this._gifFrameDeliveredVersion
            };
        }

        _restoreSnapshot(snapshot) {
            if (!snapshot) return;
            this.mode = snapshot.mode || "image";
            this.image = snapshot.image || null;
            this.video = snapshot.video || null;
            this.stream = snapshot.stream || null;
            this.ready = !!snapshot.ready;
            this.failureReason = snapshot.failureReason || "";
            this.lastFrameAt = snapshot.lastFrameAt || 0;
            this.lastVideoTime = typeof snapshot.lastVideoTime === "number" ? snapshot.lastVideoTime : -1;
            this.frameIntervalMs = snapshot.frameIntervalMs || 33;
            this.gifFrameCanvas = snapshot.gifFrameCanvas || null;
            this.gifDecoder = snapshot.gifDecoder || null;
            this.gifFrames = Array.isArray(snapshot.gifFrames) ? snapshot.gifFrames : [];
            this.gifFrameIndex = snapshot.gifFrameIndex || 0;
            this.gifNextFrameAt = snapshot.gifNextFrameAt || 0;
            this._gifFrameVersion = snapshot.gifFrameVersion || 0;
            this._gifFrameDeliveredVersion = snapshot.gifFrameDeliveredVersion || 0;
        }
    }

    globalScope.JigsawMediaSourceAdapter = MediaSourceAdapter;
})(window);

