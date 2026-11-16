/* Super Baldi Maker: static-host loader. No Unity gameplay automation. */
(function () {
  "use strict";
  const packageConfig = window.SBM_PACKAGE || {};
  const build = window.SBM_UNITY_BUILD;
  const canvas = document.getElementById("unity-canvas");
  const status = document.getElementById("sbm-status");
  const progress = document.getElementById("sbm-progress");
  const bar = document.getElementById("sbm-progress-bar");
  const percent = document.getElementById("sbm-percent");
  const start = document.getElementById("sbm-start");
  const retry = document.getElementById("sbm-retry");
  const warning = document.getElementById("sbm-warning");
  const blobs = new Set();
  const releaseAtReady = new Set();
  const originalFetch = window.fetch.bind(window);
  window.SBMWebGL = {state:"loading", progress:0, base:"", error:null};

  // The portal's srcdoc polyfill disables IDBFS. A same-origin parent may still provide the native factory.
  if (!window.indexedDB && window.parent !== window) {
    try {
      if (window.parent.indexedDB) Object.defineProperty(window, "indexedDB", {value:window.parent.indexedDB, configurable:true});
    } catch (_) { /* Browser privacy/sandbox policy may deny durable storage. */ }
  }
  function directory(url) { return String(url).replace(/[?#].*$/, "").replace(/[^/]*$/, ""); }
  function join(base, path) {
    if (/^https?:\/\//i.test(path)) return path;
    return base + path.split("/").map(encodeURIComponent).join("/");
  }
  // Use DOM URL resolution: the existing portal replaces the window.URL constructor.
  const anchor = document.createElement("a"); anchor.href = document.baseURI;
  const localBase = directory(anchor.href);
  const rawBase = packageConfig.rawBase ? packageConfig.rawBase.replace(/\/?$/, "/") : "";
  const embedded = /^about:(srcdoc|blank)/i.test(window.location.href) || /cdn\.jsdelivr\.net\/gh\//i.test(document.baseURI);
  const bases = Array.from(new Set((embedded && rawBase ? [rawBase, localBase] : [localBase, rawBase]).filter(Boolean)));
  let preferredBase = bases[0], manifest = null, downloaded = 0, expectedDownload = 0;
  const descriptors = new Map();
  function setProgress(value, message) {
    value = Math.max(0, Math.min(1, value));
    window.SBMWebGL.progress = value;
    bar.style.width = (value * 100).toFixed(1) + "%";
    percent.textContent = Math.floor(value * 100) + "%";
    progress.setAttribute("aria-valuenow", String(Math.floor(value * 100)));
    if (message) status.textContent = message;
  }
  function fail(error) {
    window.SBMWebGL.state = "error"; window.SBMWebGL.error = String(error && error.message || error);
    document.getElementById("sbm-overlay").hidden = false;
    status.textContent = "The game couldn't load. Check your connection and try again.";
    retry.hidden = false; start.hidden = true;
    document.getElementById("sbm-error").hidden = false;
    document.getElementById("sbm-error-detail").textContent = window.SBMWebGL.error;
  }
  function showBanner(message, type) {
    if (type === "error") { fail(new Error(String(message).replace(/<[^>]*>/g, ""))); return; }
    warning.textContent = String(message).replace(/<[^>]*>/g, ""); warning.hidden = false;
    setTimeout(function () { warning.hidden = true; }, 9000);
  }
  function candidates() { return Array.from(new Set([preferredBase].concat(bases))); }
  async function fetchFile(path, expected) {
    const failures = [];
    for (const base of candidates()) {
      const url = join(base, path);
      try {
        const response = await originalFetch(url, {credentials:"omit"});
        if (!response.ok) throw new Error("HTTP " + response.status);
        const data = new Uint8Array(await response.arrayBuffer());
        if (expected && data.byteLength !== expected.bytes) throw new Error("Unexpected file size");
        if (expected && expected.sha256) {
          if (!window.crypto || !window.crypto.subtle) throw new Error("A secure HTTPS connection is required to verify game files");
          const hash = new Uint8Array(await window.crypto.subtle.digest("SHA-256", data));
          const actual = Array.from(hash, value => value.toString(16).padStart(2,"0")).join("");
          if (actual !== expected.sha256) throw new Error("File checksum mismatch");
        }
        return {data:data, base:base};
      } catch (error) { failures.push(url + " — " + error.message); }
    }
    throw new Error("Couldn't download " + path + "\n" + failures.join("\n"));
  }
  async function loadManifest() {
    if (!packageConfig.packaged) return;
    const result = await fetchFile(packageConfig.manifest || "sbm-payloads.json");
    preferredBase = result.base; window.SBMWebGL.base = preferredBase;
    manifest = JSON.parse(new TextDecoder().decode(result.data));
    if (manifest.version !== 1 || !Array.isArray(manifest.payloads)) throw new Error("Unsupported game package manifest");
    for (const file of manifest.payloads) descriptors.set(file.path, file);
  }
  function account(bytes) {
    downloaded += bytes;
    if (expectedDownload) setProgress(.65 * Math.min(1, downloaded / expectedDownload), "Downloading game... " + (downloaded / 1048576).toFixed(1) + " MB");
  }
  async function payload(path, mime, releaseWhenReady) {
    const file = descriptors.get(path);
    const pieces = [];
    if (file && file.parts) {
      let length = 0;
      for (const part of file.parts) {
        const result = await fetchFile(part.path, part); pieces.push(result.data); length += result.data.length; account(result.data.length);
      }
      if (length !== file.bytes) throw new Error("Incomplete game payload: " + path);
      // Full-file digest is verified in addition to every part, before Unity sees the reconstructed payload.
      const combined = new Uint8Array(length); let position = 0;
      for (const piece of pieces) { combined.set(piece, position); position += piece.length; }
      pieces.length = 0;
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", combined));
      const actual = Array.from(hash, value => value.toString(16).padStart(2,"0")).join("");
      if (actual !== file.sha256) throw new Error("Reassembled game checksum mismatch: " + path);
      pieces.push(combined);
    } else {
      const result = await fetchFile(path, file); pieces.push(result.data); account(result.data.length);
      if (!manifest) preferredBase = result.base;
    }
    const url = window.URL.createObjectURL(new Blob(pieces, {type:mime})); blobs.add(url);
    if (releaseWhenReady) releaseAtReady.add(url);
    // Preserve Unity's original suffix checks while keeping the plain object URL for revocation.
    return url + "#" + encodeURIComponent(path);
  }
  function loadScript(url) {
    return new Promise(function (resolve,reject) {
      const script = document.createElement("script"); script.src = url;
      script.onload = resolve; script.onerror = function () { reject(new Error("The game loader script couldn't start")); };
      document.body.appendChild(script);
    });
  }
  function unlockAudio() {
    try { if (window.SBMAudio && typeof window.SBMAudio.unlock === "function") window.SBMAudio.unlock(); } catch (_) {}
    const instance = window.unityInstance;
    const modules = [instance && instance.Module, window.Module];
    for (const module of modules) {
      if (!module) continue;
      const contexts = [module.WEBAudio && module.WEBAudio.audioContext, module.audioContext, module.AudioContext];
      for (const context of contexts) {
        try { if (context && typeof context.resume === "function") { const promise = context.resume(); if (promise && promise.catch) promise.catch(function () {}); } } catch (_) {}
      }
    }
  }
  start.addEventListener("click", function (event) {
    if (!event.isTrusted) return;
    unlockAudio(); document.getElementById("sbm-overlay").hidden = true;
    window.SBMWebGL.state = "started"; canvas.focus();
    if (!window.indexedDB) showBanner("Saving is restricted in this browser. Download your schools to keep a backup.","warning");
  });
  retry.addEventListener("click", function () { window.location.reload(); });
  document.getElementById("sbm-fullscreen").addEventListener("click", function (event) {
    if (!event.isTrusted || !window.unityInstance) return;
    unlockAudio(); window.unityInstance.SetFullscreen(1); canvas.focus();
  });
  window.addEventListener("pagehide", function () { for (const url of blobs) window.URL.revokeObjectURL(url); });
  async function boot() {
    if (!build || !build.config) throw new Error("The Unity build configuration is missing");
    await loadManifest();
    const config = Object.assign({}, build.config, {
      autoSyncPersistentDataPath:true,showBanner:showBanner,
      // Reconstructed blob URLs change every visit. Cache the immutable HTTP
      // chunks in the browser, rather than retaining another data archive per blob.
      cacheControl:function () { return "no-store"; }
    });
    const keys = ["dataUrl","frameworkUrl","codeUrl","memoryUrl","symbolsUrl","workerUrl"].filter(key => config[key]);
    expectedDownload = [build.loaderUrl].concat(keys.map(key => config[key])).reduce((sum,path) => sum + (descriptors.get(path)?.bytes || 0),0);
    const loader = await payload(build.loaderUrl,"application/javascript");
    for (const key of keys) config[key] = await payload(config[key], key === "codeUrl" ? "application/wasm" : key === "frameworkUrl" || key === "workerUrl" ? "application/javascript" : "application/octet-stream", key === "dataUrl" || key === "codeUrl" || key === "memoryUrl");
    // Keep StreamingAssets on its real absolute folder URL; do not turn the folder into a blob URL.
    config.streamingAssetsUrl = join(preferredBase, build.config.streamingAssetsUrl || "StreamingAssets");
    window.SBMWebGL.base = preferredBase;
    await loadScript(loader);
    if (typeof window.createUnityInstance !== "function") throw new Error("Unity's loader did not initialize");
    const instance = await window.createUnityInstance(canvas,config,function (value) { setProgress(.65 + .35 * value,"Starting Super Baldi Maker..."); });
    window.unityInstance = instance;
    setProgress(1,"Ready! Click below to start with sound."); window.SBMWebGL.state = "ready";
    start.hidden = false; document.getElementById("sbm-fullscreen").hidden = false;
    for (const url of releaseAtReady) { window.URL.revokeObjectURL(url); blobs.delete(url); }
    releaseAtReady.clear();
    start.focus();
  }
  boot().catch(fail);
})();
