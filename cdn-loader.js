(function () {
  const defaultConfig = {
    enabled: true,
    repo: "spinerak/JigsawAP",
    tag: "v0.0.0"
  };

  const config = Object.assign({}, defaultConfig, window.JIGSAW_CDN_CONFIG || {});
  const styles = [{ path: "style.css" }];
  const scripts = [
    { path: "clientandpreview.js", module: true },
    { path: "loadimages.js", module: true },
    { path: "aplogin.js", module: true },
    { path: "src/core/PuzzleSceneState.js", module: false },
    { path: "src/core/PieceSetupQueue.js", module: false },
    { path: "src/core/HitTestService.js", module: false },
    { path: "src/render/RenderScheduler.js", module: false },
    { path: "src/media/MediaSourceAdapter.js", module: false },
    { path: "src/media/MediaBindings.js", module: false },
    { path: "src/render/canvas2d/CanvasRenderer.js", module: false },
    { path: "src/render/webgl/WebGLRenderer.js", module: false },
    { path: "src/render/RendererFacade.js", module: false },
    { path: "src/ui/ViewControls.js", module: false },
    { path: "src/ui/RendererModeControl.js", module: false },
    { path: "src/integration/ArchipelagoBridge.js", module: false },
    { path: "script.js", module: false }
  ];

  function localUrl(relativePath) {
    return `./${relativePath}`;
  }

  function cdnRoot() {
    return `https://cdn.jsdelivr.net/gh/${config.repo}@${config.tag}`;
  }

  async function tryFetchJson(url) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        return null;
      }
      return await response.json();
    } catch {
      return null;
    }
  }

  async function resolveManifest() {
    if (config.enabled) {
      const cdnManifest = await tryFetchJson(`${cdnRoot()}/dist-assets/manifest.json`);
      if (cdnManifest && cdnManifest.assets) {
        return { source: "cdn", assets: cdnManifest.assets };
      }
    }

    const localManifest = await tryFetchJson("./dist-assets/manifest.json");
    if (localManifest && localManifest.assets) {
      return { source: "local-dist", assets: localManifest.assets };
    }

    return { source: "local", assets: {} };
  }

  function resolveUrl(manifestInfo, relativePath) {
    const mapped = manifestInfo.assets[relativePath];
    if (!mapped) {
      return localUrl(relativePath);
    }

    if (manifestInfo.source === "cdn") {
      return `${cdnRoot()}/${mapped}`;
    }

    if (manifestInfo.source === "local-dist") {
      return localUrl(mapped);
    }

    return localUrl(relativePath);
  }

  function loadCss(manifestInfo) {
    const styleDescriptor = styles[0];
    if (!styleDescriptor) {
      return Promise.resolve();
    }

    const localHref = localUrl(styleDescriptor.path);
    const targetHref = resolveUrl(manifestInfo, styleDescriptor.path);
    const existingLink =
      document.querySelector('link[rel="stylesheet"][href="./style.css"]') ||
      document.querySelector('link[rel="stylesheet"]');

    if (!existingLink || targetHref === localHref) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const replacementLink = document.createElement("link");
      replacementLink.rel = "stylesheet";
      replacementLink.href = targetHref;
      replacementLink.crossOrigin = "anonymous";
      replacementLink.onload = () => {
        existingLink.remove();
        resolve();
      };
      replacementLink.onerror = () => {
        resolve();
      };
      document.head.appendChild(replacementLink);
    });
  }

  function loadScriptSequentially(manifestInfo, descriptor) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const localSrc = localUrl(descriptor.path);
      const targetSrc = resolveUrl(manifestInfo, descriptor.path);
      const needsFallback = targetSrc !== localSrc;

      script.src = targetSrc;
      script.async = false;
      if (descriptor.module) {
        script.type = "module";
      }
      if (manifestInfo.source === "cdn") {
        script.crossOrigin = "anonymous";
      }

      script.onload = () => resolve();
      script.onerror = () => {
        if (!needsFallback) {
          reject(new Error(`Failed to load ${targetSrc}`));
          return;
        }

        const fallback = document.createElement("script");
        fallback.src = localSrc;
        fallback.async = false;
        if (descriptor.module) {
          fallback.type = "module";
        }
        fallback.onload = () => resolve();
        fallback.onerror = () => reject(new Error(`Fallback failed for ${localSrc}`));
        document.body.appendChild(fallback);
      };

      document.body.appendChild(script);
    });
  }

  (async function start() {
    const manifestInfo = await resolveManifest();
    await loadCss(manifestInfo);

    for (const descriptor of scripts) {
      await loadScriptSequentially(manifestInfo, descriptor);
    }
  })();
})();
