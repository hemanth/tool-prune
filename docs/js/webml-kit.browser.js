var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/streaming.ts
var TokenStream = class {
  queue = [];
  resolve = null;
  done = false;
  error = null;
  abortHandler = null;
  constructor(signal) {
    if (signal) {
      this.abortHandler = () => {
        this.abort(new Error("Stream aborted"));
      };
      signal.addEventListener("abort", this.abortHandler, { once: true });
    }
  }
  /** Push a new token event into the stream. */
  push(event) {
    if (this.done) return;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }
  /** Signal that generation is complete. */
  end() {
    this.done = true;
    this.cleanup();
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: void 0, done: true });
    }
  }
  /** Signal an error. */
  abort(error) {
    this.error = error;
    this.done = true;
    this.cleanup();
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: void 0, done: true });
    }
  }
  /** Get the accumulated error, if any. */
  getError() {
    return this.error;
  }
  cleanup() {
    if (this.abortHandler) {
      this.abortHandler = null;
    }
  }
  // ─── AsyncIterable implementation ───
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({
            value: this.queue.shift(),
            done: false
          });
        }
        if (this.done) {
          return Promise.resolve({
            value: void 0,
            done: true
          });
        }
        return new Promise((resolve) => {
          this.resolve = resolve;
        });
      },
      return: () => {
        this.done = true;
        this.cleanup();
        return Promise.resolve({
          value: void 0,
          done: true
        });
      }
    };
  }
};
async function collectStream(stream) {
  let text = "";
  let tps = 0;
  let numTokens = 0;
  let timeToFirstToken = 0;
  for await (const event of stream) {
    text += event.token;
    tps = event.tps;
    numTokens = event.numTokens;
    if (timeToFirstToken === 0) {
      timeToFirstToken = event.timeToFirstToken;
    }
  }
  const error = stream.getError();
  if (error) throw error;
  return { text, tps, numTokens, timeToFirstToken };
}

// src/gpu-recovery.ts
var GPURecovery = class {
  state = "idle";
  listeners = /* @__PURE__ */ new Map();
  maxRetries;
  baseDelay;
  constructor(options) {
    this.maxRetries = options?.maxRetries ?? 3;
    this.baseDelay = options?.baseDelayMs ?? 1e3;
  }
  /** Current recovery state. */
  getState() {
    return this.state;
  }
  /** Register a listener for recovery events. */
  on(event, listener) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, /* @__PURE__ */ new Set());
    }
    this.listeners.get(event).add(listener);
  }
  /** Remove a listener. */
  off(event, listener) {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event, data) {
    this.listeners.get(event)?.forEach((fn) => fn(data));
  }
  setState(state) {
    this.state = state;
    this.emit("state-change", state);
  }
  /**
   * Watch a GPU device for loss. When the device is lost, automatically
   * attempt to re-acquire an adapter.
   *
   * @returns The same device (for chaining)
   */
  watchDevice(device) {
    device.lost.then((info) => {
      const reason = info.message || "unknown";
      if (info.reason === "destroyed") {
        this.setState("idle");
        return;
      }
      this.setState("lost");
      this.emit("lost", { reason });
      this.attemptRecovery(0);
    });
    this.setState("idle");
    return device;
  }
  async attemptRecovery(attempt) {
    if (attempt >= this.maxRetries) {
      this.setState("failed");
      this.emit("failed", {
        attempts: attempt,
        lastError: "Max retries exceeded"
      });
      return;
    }
    this.setState("recovering");
    const delay = this.baseDelay * 2 ** attempt;
    await new Promise((r) => setTimeout(r, delay));
    try {
      if (typeof navigator === "undefined" || !("gpu" in navigator)) {
        throw new Error("WebGPU not available");
      }
      const adapter = await navigator.gpu.requestAdapter({
        powerPreference: "high-performance"
      });
      if (!adapter) {
        throw new Error("No GPU adapter available");
      }
      this.setState("recovered");
      this.emit("recovered", { adapter });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.attemptRecovery(attempt + 1);
    }
  }
};

// src/model-client.ts
var ModelClient = class {
  worker = null;
  workerUrl;
  listeners = /* @__PURE__ */ new Map();
  pendingRequests = /* @__PURE__ */ new Map();
  requestCounter = 0;
  deviceInfo = null;
  loadedModels = /* @__PURE__ */ new Set();
  progressCallback = null;
  gpuRecovery;
  /**
   * Create a new ModelClient.
   *
   * @param workerUrl - URL to the model-worker.js file. If omitted,
   *   creates a Blob URL from the bundled worker (requires bundler support).
   */
  constructor(workerUrl) {
    this.workerUrl = workerUrl ?? null;
    this.gpuRecovery = new GPURecovery();
    this.gpuRecovery.on("lost", ({ reason }) => {
      this.emit("device-lost", { reason });
    });
    this.gpuRecovery.on("recovered", () => {
      this.emit("device-recovered", {});
    });
  }
  // ─── Worker Lifecycle ───
  getWorker() {
    if (!this.worker) {
      const url = this.workerUrl ?? new URL("./model-worker.js", import.meta.url);
      this.worker = new Worker(url, { type: "module" });
      this.worker.addEventListener("message", this.handleMessage.bind(this));
      this.worker.addEventListener("error", (e) => {
        this.emit("error", { message: e.message });
      });
    }
    return this.worker;
  }
  send(cmd) {
    this.getWorker().postMessage(cmd);
  }
  nextId() {
    return `req_${++this.requestCounter}_${Date.now()}`;
  }
  // ─── Message Handler ───
  handleMessage(e) {
    const msg = e.data;
    switch (msg.type) {
      case "device-info": {
        this.deviceInfo = msg.data;
        const pending = this.pendingRequests.get("detect");
        if (pending) {
          pending.resolve(msg.data);
          this.pendingRequests.delete("detect");
        }
        break;
      }
      case "progress": {
        this.progressCallback?.(msg.data);
        this.emit("progress", msg.data);
        break;
      }
      case "ready": {
        this.loadedModels.add(msg.modelKey);
        this.emit("ready", { modelKey: msg.modelKey });
        const pending = this.pendingRequests.get("load");
        if (pending) {
          pending.resolve(void 0);
          this.pendingRequests.delete("load");
        }
        break;
      }
      case "token": {
        const pending = this.pendingRequests.get(msg.id);
        if (pending?.stream) {
          pending.stream.push(msg.data);
        }
        break;
      }
      case "result": {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          if (pending.stream) {
            pending.stream.end();
          }
          pending.resolve(msg.data);
          this.pendingRequests.delete(msg.id);
        }
        break;
      }
      case "error": {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          if (pending.stream) {
            pending.stream.abort(new Error(msg.data));
          }
          pending.reject(new Error(msg.data));
          this.pendingRequests.delete(msg.id);
        }
        this.emit("error", { message: msg.data, id: msg.id });
        break;
      }
      case "device-lost": {
        this.emit("device-lost", { reason: msg.reason });
        break;
      }
      case "device-recovered": {
        this.emit("device-recovered", {});
        break;
      }
    }
  }
  // ─── Events ───
  /** Register an event listener. */
  on(event, listener) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, /* @__PURE__ */ new Set());
    }
    this.listeners.get(event).add(listener);
    return this;
  }
  /** Remove an event listener. */
  off(event, listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  emit(event, data) {
    this.listeners.get(event)?.forEach((fn) => fn(data));
  }
  // ─── Public API ───
  /**
   * Detect the best available compute backend.
   *
   * ```ts
   * const info = await client.detect();
   * console.log(info.backend);         // 'webgpu'
   * console.log(info.gpu?.vendor);      // 'apple'
   * console.log(info.recommendedDtype); // 'q4'
   * ```
   */
  async detect() {
    if (this.deviceInfo) return this.deviceInfo;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set("detect", { resolve, reject });
      this.send({ type: "check" });
    });
  }
  /**
   * Load a model pipeline.
   *
   * ```ts
   * await client.load({
   *   task: 'text-generation',
   *   modelId: 'onnx-community/Bonsai-1.7B-ONNX',
   *   dtype: 'q4',
   *   onProgress: ({ percent }) => updateUI(percent),
   * });
   * ```
   */
  async load(options) {
    this.progressCallback = options.onProgress ?? null;
    const config = {
      task: options.task,
      modelId: options.modelId,
      dtype: options.dtype,
      device: options.device,
      revision: options.revision
    };
    return new Promise((resolve, reject) => {
      this.pendingRequests.set("load", { resolve, reject });
      this.send({ type: "load", config });
    });
  }
  /**
   * Run one-shot inference for any pipeline task.
   *
   * ```ts
   * // Image classification
   * const labels = await client.run('image-classification', imageUrl);
   *
   * // Speech recognition
   * const { text } = await client.run('automatic-speech-recognition', audioBlob);
   *
   * // Embeddings
   * const vectors = await client.run('feature-extraction', 'Hello world');
   * ```
   */
  async run(task, input, options) {
    const id = this.nextId();
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.send({ type: "run", id, task, input, options });
    });
  }
  /**
   * Generate text with streaming tokens.
   *
   * Returns an `AsyncIterable<TokenEvent>` that yields tokens as they're generated.
   *
   * ```ts
   * for await (const { token, tps } of client.stream('Tell me a joke')) {
   *   process.stdout.write(token);
   * }
   * ```
   */
  stream(input, options) {
    const id = this.nextId();
    const stream = new TokenStream(options?.signal);
    this.pendingRequests.set(id, {
      resolve: () => {
      },
      // Result comes through the stream
      reject: (err) => stream.abort(err),
      stream
    });
    this.send({
      type: "run",
      id,
      task: "text-generation",
      input,
      options
    });
    return stream;
  }
  /**
   * Generate text and wait for the complete result.
   *
   * ```ts
   * const { text, tps, numTokens } = await client.generate('Hello!');
   * ```
   */
  async generate(input, options) {
    const tokenStream = this.stream(input, options);
    const collected = await collectStream(tokenStream);
    return {
      ...collected,
      totalTime: 0
      // Will be filled from worker result
    };
  }
  /**
   * Interrupt an ongoing text generation.
   */
  interrupt() {
    this.send({ type: "interrupt" });
  }
  /**
   * Reset the KV cache (start a new conversation).
   */
  reset() {
    this.send({ type: "reset" });
  }
  /**
   * Dispose a loaded model and free memory.
   *
   * @param modelKey - Specific model key (task::modelId), or omit to dispose all.
   */
  dispose(modelKey) {
    this.send({ type: "dispose", modelKey });
    if (modelKey) {
      this.loadedModels.delete(modelKey);
    } else {
      this.loadedModels.clear();
    }
  }
  /**
   * Check if a model is currently loaded.
   */
  isLoaded(task, modelId) {
    return this.loadedModels.has(`${task}::${modelId}`);
  }
  /**
   * Terminate the worker completely.
   */
  terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.loadedModels.clear();
    this.pendingRequests.clear();
    this.deviceInfo = null;
  }
};

// src/hub.ts
var HF_API = "https://huggingface.co/api";
var WEBGPU_ORGS = [
  "onnx-community",
  "Xenova",
  "webml-community"
];
async function searchModels(options = {}) {
  const params = new URLSearchParams();
  params.set("library", "transformers.js");
  if (options.task) params.set("pipeline_tag", options.task);
  if (options.query) params.set("search", options.query);
  if (options.author) params.set("author", options.author);
  if (options.sort === "trending") {
    params.set("sort", "trending");
  } else if (options.sort) {
    params.set("sort", options.sort === "modified" ? "lastModified" : options.sort);
    params.set("direction", options.direction === "asc" ? "1" : "-1");
  } else {
    params.set("sort", "downloads");
    params.set("direction", "-1");
  }
  params.set("limit", String(Math.min(options.limit ?? 20, 100)));
  const url = `${HF_API}/models?${params.toString()}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HF Hub API error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return data.map(normalizeModel);
}
async function listModelsForTask(task, limit = 10) {
  return searchModels({ task, sort: "downloads", limit });
}
async function trendingModels(limit = 10) {
  return searchModels({ sort: "trending", limit });
}
async function listWebGPUModels(options = {}) {
  const results = [];
  for (const org of WEBGPU_ORGS) {
    const models = await searchModels({ ...options, author: org });
    results.push(...models);
  }
  const seen = /* @__PURE__ */ new Set();
  return results.filter((m) => {
    if (seen.has(m.modelId)) return false;
    seen.add(m.modelId);
    return true;
  }).sort((a, b) => b.downloads - a.downloads);
}
async function getModelInfo(modelId) {
  const response = await fetch(`${HF_API}/models/${modelId}`);
  if (!response.ok) {
    throw new Error(`Model not found: ${modelId} (${response.status})`);
  }
  const data = await response.json();
  return normalizeModel(data);
}
function normalizeModel(raw) {
  const id = raw.modelId ?? raw.id ?? "unknown";
  const tags = raw.tags ?? [];
  const author = raw.author ?? id.split("/")[0] ?? "unknown";
  return {
    modelId: id,
    task: raw.pipeline_tag ?? "unknown",
    author,
    downloads: raw.downloads ?? 0,
    likes: raw.likes ?? 0,
    lastModified: raw.lastModified ?? "",
    tags,
    webgpuCompatible: tags.includes("onnx") || WEBGPU_ORGS.some((org) => id.startsWith(org))
  };
}

// src/shim-ort.ts
var shim_ort_exports = {};
__export(shim_ort_exports, {
  InferenceSession: () => InferenceSession,
  Tensor: () => Tensor,
  default: () => shim_ort_default,
  env: () => env
});
var getOrt = () => {
  if (typeof globalThis !== "undefined" && globalThis.ort) {
    return globalThis.ort;
  }
  return {};
};
var ortProxy = new Proxy(
  {},
  {
    get(_target, prop) {
      const ort = getOrt();
      return ort[prop];
    }
  }
);
var shim_ort_default = ortProxy;
var InferenceSession = new Proxy(
  {},
  {
    get(_target, prop) {
      return getOrt().InferenceSession?.[prop];
    }
  }
);
var Tensor = function(...args) {
  const OrtTensor = getOrt().Tensor;
  return new OrtTensor(...args);
};
var env = new Proxy(
  {},
  {
    get(_target, prop) {
      return getOrt().env?.[prop];
    },
    set(_target, prop, value) {
      const ort = getOrt();
      if (ort.env) {
        ort.env[prop] = value;
      }
      return true;
    }
  }
);

// src/onnx-pipeline.ts
var runtimeOrt = typeof globalThis !== "undefined" && globalThis.ort ? globalThis.ort : shim_ort_exports;
if (runtimeOrt?.env?.wasm) {
  runtimeOrt.env.wasm.simd = true;
  if (typeof navigator !== "undefined" && navigator.hardwareConcurrency) {
    runtimeOrt.env.wasm.numThreads = Math.min(navigator.hardwareConcurrency, 4);
  }
}
var HF_BASE = "https://huggingface.co";
async function fetchRepoFiles(modelId) {
  try {
    const res = await fetch(`https://huggingface.co/api/models/${modelId}`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.siblings ?? []).map((s) => s.rfilename);
  } catch {
    return [];
  }
}
function resolveAssetUrl(modelId, filename, revision = "main") {
  if (filename.startsWith("http://") || filename.startsWith("https://") || filename.startsWith("/") || filename.startsWith("./")) {
    return filename;
  }
  return `${HF_BASE}/${modelId}/resolve/${revision}/${filename}`;
}
var DEFAULT_ONNX_CACHE_NAME = "webml-kit-onnx-cache";
async function downloadAsset(url, fileName, onProgress, useCache = true, cacheName = DEFAULT_ONNX_CACHE_NAME) {
  if (typeof process !== "undefined" && process.versions?.node && !url.startsWith("http://") && !url.startsWith("https://")) {
    const fs = await import("node:fs/promises");
    const path = url.startsWith("file://") ? new URL(url) : url;
    const buf = await fs.readFile(path);
    onProgress?.({
      status: "downloading",
      file: fileName,
      loaded: buf.byteLength,
      total: buf.byteLength,
      percent: 100
    });
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  let cache = null;
  if (useCache && typeof caches !== "undefined") {
    try {
      cache = await caches.open(cacheName);
      const cached = await cache.match(url);
      if (cached) {
        const buf = await cached.arrayBuffer();
        onProgress?.({
          status: "ready",
          file: fileName,
          loaded: buf.byteLength,
          total: buf.byteLength,
          percent: 100
        });
        return buf;
      }
    } catch (err) {
      console.warn("Cache API lookup failed, fetching over network:", err);
    }
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${fileName} from ${url}: ${response.status} ${response.statusText}`);
  }
  const contentLength = response.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  if (!response.body || total === 0) {
    const buffer = await response.arrayBuffer();
    if (cache) {
      try {
        await cache.put(url, new Response(buffer.slice(0), {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(buffer.byteLength)
          }
        }));
      } catch (err) {
        console.warn("Failed to cache asset in Cache API:", err);
      }
    }
    onProgress?.({
      status: "downloading",
      file: fileName,
      loaded: buffer.byteLength,
      total: buffer.byteLength,
      percent: 100
    });
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.length;
      const percent = total > 0 ? Math.round(loaded / total * 100) : 0;
      onProgress?.({
        status: "downloading",
        file: fileName,
        loaded,
        total,
        percent
      });
    }
  }
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  if (cache) {
    try {
      await cache.put(url, new Response(merged.buffer.slice(0), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(loaded)
        }
      }));
    } catch (err) {
      console.warn("Failed to cache asset in Cache API:", err);
    }
  }
  return merged.buffer;
}
async function createSession(modelBufferOrPath, preferredBackend = "webgpu") {
  const model = modelBufferOrPath instanceof ArrayBuffer ? new Uint8Array(modelBufferOrPath) : modelBufferOrPath;
  if (preferredBackend === "webgpu") {
    try {
      const session2 = await runtimeOrt.InferenceSession.create(model, {
        executionProviders: ["webgpu"]
      });
      return { session: session2, backend: "webgpu" };
    } catch (err) {
      console.warn("WebGPU session creation failed, falling back to wasm:", err);
    }
  }
  const session = await runtimeOrt.InferenceSession.create(model, {
    executionProviders: ["wasm"]
  });
  return { session, backend: "wasm" };
}
function decodeWavToFloat32(buffer) {
  const view = new DataView(buffer);
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  if (riff !== "RIFF" || wave !== "WAVE") {
    return new Float32Array(buffer);
  }
  let offset = 12;
  let audioFormat = 1;
  let numChannels = 1;
  let bitsPerSample = 16;
  let dataOffset = 0;
  let dataLength = 0;
  while (offset < view.byteLength - 8) {
    const chunkId = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === "fmt ") {
      audioFormat = view.getUint16(offset + 8, true);
      numChannels = view.getUint16(offset + 10, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      dataLength = chunkSize;
      break;
    }
    offset += 8 + chunkSize;
  }
  if (dataOffset === 0) {
    return new Float32Array(buffer);
  }
  if (audioFormat === 1 && bitsPerSample === 16) {
    const numSamples = Math.floor(dataLength / (2 * numChannels));
    const pcm = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      let sum = 0;
      for (let c = 0; c < numChannels; c++) {
        const idx = dataOffset + (i * numChannels + c) * 2;
        if (idx + 1 < view.byteLength) {
          sum += view.getInt16(idx, true) / 32768;
        }
      }
      pcm[i] = sum / numChannels;
    }
    return pcm;
  }
  if (audioFormat === 3 && bitsPerSample === 32) {
    const numSamples = Math.floor(dataLength / (4 * numChannels));
    const pcm = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      let sum = 0;
      for (let c = 0; c < numChannels; c++) {
        const idx = dataOffset + (i * numChannels + c) * 4;
        if (idx + 3 < view.byteLength) {
          sum += view.getFloat32(idx, true);
        }
      }
      pcm[i] = sum / numChannels;
    }
    return pcm;
  }
  return new Float32Array(buffer.slice(dataOffset, dataOffset + dataLength));
}
function toFloat32Array(input) {
  if (input instanceof Float32Array) return input;
  if (Array.isArray(input)) return new Float32Array(input);
  if (input instanceof ArrayBuffer) return decodeWavToFloat32(input);
  if (ArrayBuffer.isView(input)) return new Float32Array(input.buffer, input.byteOffset, input.byteLength / 4);
  if (typeof input === "object" && input !== null && "audio" in input) {
    return toFloat32Array(input.audio);
  }
  throw new Error(`Unsupported audio input format: ${typeof input}`);
}
function decodeCTC(logprobs, timeSteps, numClasses, vocab) {
  let prevClass = 0;
  let text = "";
  for (let t = 0; t < timeSteps; t++) {
    const offset = t * numClasses;
    let maxVal = -Infinity;
    let argmax = 0;
    for (let c = 0; c < numClasses; c++) {
      const val = logprobs[offset + c];
      if (val > maxVal) {
        maxVal = val;
        argmax = c;
      }
    }
    if (argmax === 0) {
      prevClass = 0;
      continue;
    }
    if (argmax !== prevClass) {
      const token = vocab[argmax] ?? "";
      text += token;
      prevClass = argmax;
    }
  }
  return text.replace(/\u2581/g, " ").replace(/\s+/g, " ").trim();
}
async function createOnnxPipeline(config, onProgress) {
  const preferredDevice = config.device ?? "webgpu";
  const revision = config.revision ?? "main";
  const useCache = config.cache !== false;
  const cacheName = config.cacheName || DEFAULT_ONNX_CACHE_NAME;
  let modelFile = config.modelFile;
  let preprocessorFile = config.preprocessorFile;
  let vocabFile = config.vocabFile;
  if (!modelFile && !config.modelId.endsWith(".onnx")) {
    const repoFiles = await fetchRepoFiles(config.modelId);
    if (repoFiles.length > 0) {
      if (!modelFile) {
        modelFile = repoFiles.find((f) => f.endsWith(".onnx") && !f.includes("preprocess")) ?? repoFiles.find((f) => f.endsWith(".onnx"));
      }
      if (!preprocessorFile) {
        preprocessorFile = repoFiles.find((f) => f.endsWith(".onnx") && f.includes("preprocess"));
      }
      if (!vocabFile) {
        vocabFile = repoFiles.find((f) => f.endsWith(".json") && (f.includes("vocab") || f.includes("tokens")));
      }
    }
  }
  if (!modelFile) {
    modelFile = config.modelId.endsWith(".onnx") ? config.modelId : "model.onnx";
  }
  const modelUrl = resolveAssetUrl(config.modelId, modelFile, revision);
  const modelBuffer = await downloadAsset(modelUrl, modelFile, onProgress, useCache, cacheName);
  let prepSession = null;
  if (preprocessorFile) {
    const prepUrl = resolveAssetUrl(config.modelId, preprocessorFile, revision);
    const prepBuffer = await downloadAsset(prepUrl, preprocessorFile, onProgress, useCache, cacheName);
    const { session } = await createSession(prepBuffer, preferredDevice);
    prepSession = session;
  }
  let vocab = {};
  if (vocabFile) {
    const vocabUrl = resolveAssetUrl(config.modelId, vocabFile, revision);
    try {
      if (typeof process !== "undefined" && process.versions?.node && !vocabUrl.startsWith("http://") && !vocabUrl.startsWith("https://")) {
        const fs = await import("node:fs/promises");
        const path = vocabUrl.startsWith("file://") ? new URL(vocabUrl) : vocabUrl;
        const text = await fs.readFile(path, "utf-8");
        vocab = JSON.parse(text);
      } else {
        let cachedRes = null;
        if (useCache && typeof caches !== "undefined") {
          try {
            const cache = await caches.open(cacheName);
            cachedRes = await cache.match(vocabUrl) ?? null;
          } catch {
          }
        }
        if (cachedRes) {
          vocab = await cachedRes.json();
        } else {
          const res = await fetch(vocabUrl);
          if (res.ok) {
            if (useCache && typeof caches !== "undefined") {
              try {
                const cache = await caches.open(cacheName);
                await cache.put(vocabUrl, res.clone());
              } catch {
              }
            }
            vocab = await res.json();
          }
        }
      }
    } catch {
    }
  }
  let { session: modelSession, backend } = await createSession(modelBuffer, preferredDevice);
  if (config.task === "automatic-speech-recognition") {
    const runner = async (input) => {
      const pcm = toFloat32Array(input);
      const executeInference = async (sess) => {
        let acousticSignal;
        let acousticLength;
        if (prepSession) {
          const audioTensor = new runtimeOrt.Tensor("float32", pcm, [1, pcm.length]);
          const lengthTensor = new runtimeOrt.Tensor("int64", BigInt64Array.from([BigInt(pcm.length)]), [1]);
          const prepOutputs = await prepSession.run({
            audio_signal: audioTensor,
            length: lengthTensor
          });
          acousticSignal = prepOutputs.processed_signal ?? Object.values(prepOutputs)[0];
          acousticLength = prepOutputs.processed_length ?? Object.values(prepOutputs)[1];
        } else {
          acousticSignal = new runtimeOrt.Tensor("float32", pcm, [1, pcm.length]);
          acousticLength = new runtimeOrt.Tensor("int64", BigInt64Array.from([BigInt(pcm.length)]), [1]);
        }
        const feeds = {};
        const inputNames = sess.inputNames;
        if (inputNames.length >= 2) {
          feeds[inputNames[0]] = acousticSignal;
          feeds[inputNames[1]] = acousticLength;
        } else if (inputNames.length === 1) {
          feeds[inputNames[0]] = acousticSignal;
        }
        const outputs = await sess.run(feeds);
        const logprobsTensor = outputs.logprobs ?? Object.values(outputs)[0];
        const dims = logprobsTensor.dims;
        const timeSteps = dims.length === 3 ? dims[1] : dims.length === 2 ? dims[0] : 1;
        const numClasses = dims[dims.length - 1];
        const data = logprobsTensor.data;
        const text = decodeCTC(data, timeSteps, numClasses, vocab);
        return { text };
      };
      try {
        return await executeInference(modelSession);
      } catch (err) {
        if (backend === "webgpu") {
          console.warn("WebGPU inference failed, retrying on WASM provider:", err);
          const wasmResult = await createSession(modelBuffer, "wasm");
          modelSession = wasmResult.session;
          backend = "wasm";
          return await executeInference(modelSession);
        }
        throw err;
      }
    };
    const instance2 = runner;
    instance2.sessions = prepSession ? [prepSession, modelSession] : [modelSession];
    instance2.backend = backend;
    instance2.dispose = () => {
      prepSession?.release();
      modelSession.release();
    };
    return instance2;
  }
  const genericRunner = async (input) => {
    const feeds = {};
    if (typeof input === "object" && input !== null) {
      for (const [k, v] of Object.entries(input)) {
        if (v instanceof (runtimeOrt.Tensor ?? Tensor)) {
          feeds[k] = v;
        } else if (v instanceof Float32Array) {
          feeds[k] = new runtimeOrt.Tensor("float32", v, [1, v.length]);
        }
      }
    }
    const outputs = await modelSession.run(feeds);
    const result = {};
    for (const [k, v] of Object.entries(outputs)) {
      result[k] = v.data;
    }
    return result;
  };
  const instance = genericRunner;
  instance.sessions = [modelSession];
  instance.backend = backend;
  instance.dispose = () => {
    modelSession.release();
  };
  return instance;
}

// src/inputs.ts
async function coerceAudio(input) {
  if (input instanceof Float32Array) {
    return input;
  }
  if (Array.isArray(input)) {
    return new Float32Array(input);
  }
  if (input instanceof ArrayBuffer) {
    return decodeWavToFloat32(input);
  }
  if (ArrayBuffer.isView(input)) {
    if (input instanceof Uint8Array) {
      const copy = new Uint8Array(input.byteLength);
      copy.set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
      return decodeWavToFloat32(copy.buffer);
    }
    return new Float32Array(input.buffer, input.byteOffset, Math.floor(input.byteLength / 4));
  }
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    const buffer = await input.arrayBuffer();
    if (typeof AudioContext !== "undefined" || typeof globalThis.webkitAudioContext !== "undefined") {
      try {
        const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
        const ctx = new AudioCtx({ sampleRate: 16e3 });
        const audioBuf = await ctx.decodeAudioData(buffer.slice(0));
        ctx.close();
        return audioBuf.getChannelData(0);
      } catch {
        return decodeWavToFloat32(buffer);
      }
    }
    return decodeWavToFloat32(buffer);
  }
  if (typeof input === "string") {
    const response = await fetch(input);
    if (!response.ok) {
      throw new Error(`Failed to fetch audio from ${input}: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    return decodeWavToFloat32(buffer);
  }
  if (typeof input === "object" && input !== null) {
    if ("audio" in input) {
      return coerceAudio(input.audio);
    }
    if ("pcm" in input) {
      return coerceAudio(input.pcm);
    }
    if ("getChannelData" in input && typeof input.getChannelData === "function") {
      return input.getChannelData(0);
    }
  }
  throw new Error(`Unsupported audio input type: ${typeof input}`);
}
async function listenMic(onChunk, options = {}) {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone access is only available in browser environments with getUserMedia.");
  }
  const sampleRate = options.sampleRate ?? 16e3;
  const intervalSeconds = options.intervalSeconds ?? 3;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true
    }
  });
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  const audioCtx = new AudioCtx({ sampleRate });
  const source = audioCtx.createMediaStreamSource(stream);
  let pcmBuffer = [];
  const maxSamples = Math.floor(sampleRate * intervalSeconds);
  let workletNode = null;
  let scriptProcessor = null;
  const handleData = (inputData) => {
    for (let i = 0; i < inputData.length; i++) {
      pcmBuffer.push(inputData[i]);
    }
    if (pcmBuffer.length >= maxSamples) {
      const chunk = new Float32Array(pcmBuffer);
      pcmBuffer = [];
      onChunk(chunk);
    }
  };
  if (audioCtx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
    const workletCode = `
      class RecorderProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0];
          if (input && input[0]) {
            this.port.postMessage(input[0]);
          }
          return true;
        }
      }
      registerProcessor('recorder-processor', RecorderProcessor);
    `;
    const blob = new Blob([workletCode], { type: "application/javascript" });
    const workletUrl = URL.createObjectURL(blob);
    await audioCtx.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);
    workletNode = new AudioWorkletNode(audioCtx, "recorder-processor");
    workletNode.port.onmessage = (e) => {
      handleData(e.data);
    };
    source.connect(workletNode);
  } else {
    const bufferSize = 4096;
    scriptProcessor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
    scriptProcessor.onaudioprocess = (e) => {
      handleData(e.inputBuffer.getChannelData(0));
    };
    source.connect(scriptProcessor);
    scriptProcessor.connect(audioCtx.destination);
  }
  const stop = () => {
    if (pcmBuffer.length > 0) {
      onChunk(new Float32Array(pcmBuffer));
      pcmBuffer = [];
    }
    if (workletNode) workletNode.disconnect();
    if (scriptProcessor) scriptProcessor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    audioCtx.close();
  };
  return { stop };
}

// src/decision.ts
var OPENJEV_MODELS = {
  "minicpm5-2b": {
    id: "minicpm5-2b",
    name: "MiniCPM 5 2B (OpenJev)",
    url: "https://huggingface.co/openjev/MiniCPM-2B-GGUF/resolve/main/minicpm-2b-q4_k_m.gguf",
    family: "minicpm",
    sizeMB: 1250
  },
  "qwen3-0.6b": {
    id: "qwen3-0.6b",
    name: "Qwen 3 0.6B (OpenJev)",
    url: "https://huggingface.co/openjev/Qwen3-0.6B-GGUF/resolve/main/qwen3-0.6b-q4_k_m.gguf",
    family: "qwen",
    sizeMB: 480
  },
  "qwen3.5-4b": {
    id: "qwen3.5-4b",
    name: "Qwen 3.5 4B (OpenJev)",
    url: "https://huggingface.co/openjev/Qwen3.5-4B-GGUF/resolve/main/qwen3.5-4b-q4_k_m.gguf",
    family: "qwen",
    sizeMB: 2450
  }
};
var CONCEPT_KEYWORDS = {
  positive: [
    "good",
    "great",
    "excellent",
    "amazing",
    "love",
    "positive",
    "satisfied",
    "helpful",
    "fast",
    "smooth",
    "awesome",
    "best",
    "wonderful",
    "safe",
    "compliant",
    "approve",
    "approved",
    "pass",
    "passed",
    "valid",
    "success"
  ],
  negative: [
    "bad",
    "terrible",
    "awful",
    "horrible",
    "hate",
    "negative",
    "poor",
    "worst",
    "broken",
    "disappointing",
    "failed",
    "fail",
    "reject",
    "rejected",
    "deny",
    "denied",
    "invalid",
    "violate",
    "violation",
    "disallow",
    "fraud"
  ],
  urgent: [
    "urgent",
    "critical",
    "emergency",
    "asap",
    "immediately",
    "blocking",
    "p0",
    "p1",
    "severe",
    "fatal",
    "escalate",
    "outage",
    "unacceptable",
    "furious",
    "enraged",
    "losing"
  ],
  moderate: [
    "moderate",
    "medium",
    "normal",
    "standard",
    "p2",
    "routine",
    "average",
    "intermediate",
    "fair",
    "regular"
  ],
  low: [
    "low",
    "minor",
    "trivial",
    "easy",
    "p3",
    "p4",
    "info",
    "minimal",
    "casual",
    "beginner",
    "none",
    "negligible"
  ],
  bug: [
    "bug",
    "error",
    "500",
    "crash",
    "fail",
    "failing",
    "exception",
    "broken",
    "traceback",
    "glitch",
    "unexpected",
    "hang",
    "freeze",
    "defect"
  ],
  security: [
    "security",
    "unauthorized",
    "breach",
    "vulnerability",
    "hack",
    "exploit",
    "leak",
    "compromise",
    "threat",
    "suspicious",
    "malicious",
    "token",
    "auth"
  ],
  billing: [
    "billing",
    "bill",
    "charge",
    "invoice",
    "payment",
    "payout",
    "refund",
    "subscription",
    "fee",
    "price",
    "cost",
    "credit",
    "tax",
    "receipt"
  ],
  technical: [
    "code",
    "ai",
    "software",
    "data",
    "model",
    "api",
    "server",
    "database",
    "endpoint",
    "infra",
    "function",
    "developer",
    "algorithm"
  ],
  toxicity: [
    "toxic",
    "idiot",
    "stupid",
    "hate",
    "scam",
    "threat",
    "abuse",
    "harass",
    "offensive",
    "vulgar",
    "kill",
    "attack"
  ]
};
function stringifyState(state) {
  if (state === null || state === void 0) return "";
  if (typeof state === "string") return state;
  try {
    return JSON.stringify(state, null, 2);
  } catch {
    return String(state);
  }
}
function wordMatch(text, word) {
  if (!word || !text) return false;
  if (word.includes(" ")) return text.includes(word);
  return new RegExp("(^|[^a-z0-9])" + word + "([^a-z0-9]|$)", "i").test(text);
}
function extractKeywords(text) {
  const stopWords = /* @__PURE__ */ new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "has",
    "he",
    "in",
    "is",
    "it",
    "its",
    "of",
    "on",
    "that",
    "the",
    "to",
    "was",
    "were",
    "will",
    "with",
    "this",
    "your",
    "what",
    "which"
  ]);
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w));
}
function normalizeOptions(rawOptions) {
  if (!rawOptions || typeof rawOptions !== "object") {
    throw new Error("options must provide at least 2 distinct choices (either array or key-description record)");
  }
  let entries = [];
  if (Array.isArray(rawOptions)) {
    entries = rawOptions.map((opt) => String(opt).trim()).filter((opt) => opt.length > 0).map((opt) => ({ key: opt, description: opt }));
  } else {
    entries = Object.entries(rawOptions).map(([key, desc]) => ({
      key: String(key).trim(),
      description: String(desc).trim() || String(key).trim()
    }));
  }
  if (entries.length < 2) {
    throw new Error("options must provide at least 2 distinct choices (either array or key-description record)");
  }
  return entries;
}
function normalizeCriteria(rawCriteria) {
  if (!rawCriteria || typeof rawCriteria !== "object") {
    throw new Error("criteria must contain at least 2 levels (array or criteria record)");
  }
  let levels = [];
  if (Array.isArray(rawCriteria)) {
    levels = rawCriteria.map((item, idx) => ({
      index: idx,
      key: String(item).trim(),
      description: String(item).trim()
    })).filter((lvl) => lvl.key.length > 0);
  } else {
    const keys = Object.keys(rawCriteria);
    const areNumeric = keys.every((k) => !isNaN(Number(k)));
    if (areNumeric) {
      keys.sort((a, b) => Number(a) - Number(b));
    }
    levels = keys.map((key, idx) => ({
      index: idx,
      key,
      description: String(rawCriteria[key]).trim() || key
    }));
  }
  if (levels.length < 2) {
    throw new Error("criteria must contain at least 2 levels (array or criteria record)");
  }
  return levels;
}
function validateModelOptions(options) {
  const modelPreset = options.model ?? "qwen3-0.6b";
  const mode = options.mode ?? "auto";
  if (!["auto", "wllama", "heuristic"].includes(mode)) {
    throw new Error(`Invalid mode "${mode}". Supported modes: auto, wllama, heuristic`);
  }
  if (options.noulThreshold !== void 0) {
    if (typeof options.noulThreshold !== "number" || options.noulThreshold < 0 || options.noulThreshold > 1) {
      throw new Error("threshold must be between 0 and 1");
    }
  }
  if (modelPreset in OPENJEV_MODELS) {
    return {
      modelId: modelPreset,
      modelUrl: options.modelUrl || OPENJEV_MODELS[modelPreset].url,
      mode
    };
  }
  if (options.modelUrl || modelPreset.includes("/") || modelPreset.startsWith("http")) {
    return {
      modelId: modelPreset,
      modelUrl: options.modelUrl || modelPreset,
      mode
    };
  }
  throw new Error(
    `Unknown model preset "${modelPreset}". Supported presets: ${Object.keys(OPENJEV_MODELS).join(", ")} (or provide a custom modelUrl)`
  );
}
var HeuristicDecisionEngine = class {
  model;
  isHeuristic = true;
  _isLoaded = false;
  options;
  constructor(options = {}) {
    const validated = validateModelOptions(options);
    this.model = validated.modelId;
    this.options = options;
  }
  get isLoaded() {
    return this._isLoaded;
  }
  async init() {
    if (this._isLoaded) return;
    const onProgress = this.options.onProgress;
    if (onProgress) {
      onProgress({
        status: "loading",
        loaded: 50,
        total: 100,
        percent: 50,
        detail: "Initializing heuristic decision heuristics"
      });
      onProgress({
        status: "ready",
        loaded: 100,
        total: 100,
        percent: 100,
        detail: "Heuristic decision engine ready"
      });
    }
    this._isLoaded = true;
  }
  async choice(input) {
    const startTime = performance.now();
    await this.init();
    if (input.state === void 0 || input.state === null) {
      throw new Error("state is required for choice evaluation");
    }
    const normOptions = normalizeOptions(input.options);
    const stateStr = stringifyState(input.state).toLowerCase();
    const questionStr = String(input.question || input.instructions || "").toLowerCase();
    const questionWords = extractKeywords(questionStr);
    const rawScores = {};
    for (const opt of normOptions) {
      const optKeyLower = opt.key.toLowerCase();
      const optDescLower = opt.description.toLowerCase();
      let score = 0.2;
      if (wordMatch(stateStr, optKeyLower)) score += 3.5;
      if (optDescLower !== optKeyLower && wordMatch(stateStr, optDescLower)) score += 2.5;
      const descKeywords = extractKeywords(optDescLower + " " + optKeyLower);
      for (const kw of descKeywords) {
        if (wordMatch(stateStr, kw)) score += 1.2;
      }
      for (const qw of questionWords) {
        if (optDescLower.includes(qw)) score += 0.5;
      }
      for (const [concept, words] of Object.entries(CONCEPT_KEYWORDS)) {
        const matchesOption = words.some((w) => optKeyLower.includes(w) || optDescLower.includes(w));
        if (matchesOption) {
          const stateMatches = words.filter((w) => wordMatch(stateStr, w));
          if (stateMatches.length > 0) {
            score += 1.8 + Math.min(stateMatches.length * 0.4, 2);
          }
        }
      }
      rawScores[opt.key] = Math.max(0.01, score);
    }
    const expScores = normOptions.map((opt) => Math.exp(rawScores[opt.key]));
    const expSum = expScores.reduce((a, b) => a + b, 0) || 1;
    const probabilities = {};
    let winningChoice = normOptions[0].key;
    let maxProb = -1;
    for (let i = 0; i < normOptions.length; i++) {
      const optKey = normOptions[i].key;
      const prob = Number((expScores[i] / expSum).toFixed(2));
      probabilities[optKey] = prob;
      if (prob > maxProb) {
        maxProb = prob;
        winningChoice = optKey;
      }
    }
    const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
    if (sum > 0 && sum !== 1) {
      const diff = Number((1 - sum).toFixed(2));
      probabilities[winningChoice] = Math.max(0, Number((probabilities[winningChoice] + diff).toFixed(2)));
      maxProb = probabilities[winningChoice];
    }
    const confidence = Number(Math.min(0.99, Math.max(0.51, maxProb * 1.02)).toFixed(2));
    const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
    return {
      choice: winningChoice,
      confidence,
      probabilities,
      latencyMs
    };
  }
  async directChoice(input) {
    return this.choice(input);
  }
  async noul(input) {
    const startTime = performance.now();
    await this.init();
    if (input.state === void 0 || input.state === null) {
      throw new Error("state is required for noul evaluation");
    }
    const statement = String(input.statement || input.instructions || "").trim();
    if (!statement) {
      throw new Error("statement is required for noul evaluation");
    }
    const threshold = input.threshold ?? this.options.noulThreshold ?? 0.5;
    if (typeof threshold !== "number" || threshold < 0 || threshold > 1) {
      throw new Error("threshold must be between 0 and 1");
    }
    const stateStr = stringifyState(input.state).toLowerCase();
    const statementLower = statement.toLowerCase();
    const statementWords = extractKeywords(statementLower);
    let affirmativeScore = 0;
    let negativeScore = 0;
    for (const [concept, words] of Object.entries(CONCEPT_KEYWORDS)) {
      const statementHasConcept = words.some((w) => statementLower.includes(w));
      if (statementHasConcept) {
        const stateMatches = words.filter((w) => wordMatch(stateStr, w));
        if (stateMatches.length > 0) {
          affirmativeScore += 2 + Math.min(stateMatches.length * 0.6, 3);
        } else {
          negativeScore += 0.8;
        }
      }
    }
    let matchCount = 0;
    for (const kw of statementWords) {
      if (wordMatch(stateStr, kw)) matchCount++;
    }
    if (statementWords.length > 0) {
      affirmativeScore += matchCount / statementWords.length * 3;
    }
    const isNegated = statementLower.includes("not ") || statementLower.includes("never ") || statementLower.includes("no ") || statementLower.includes("non-");
    const netSignal = affirmativeScore - negativeScore;
    let prob = 1 / (1 + Math.exp(-1.2 * (netSignal - 0.5)));
    if (isNegated) {
      prob = 1 - prob;
    }
    const noulVal = Number(Math.min(0.99, Math.max(0.01, prob)).toFixed(2));
    const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
    return {
      noul: noulVal,
      passed: noulVal >= threshold,
      latencyMs
    };
  }
  async score(input) {
    const startTime = performance.now();
    await this.init();
    if (input.state === void 0 || input.state === null) {
      throw new Error("state is required for score evaluation");
    }
    const levels = normalizeCriteria(input.criteria);
    const numLevels = levels.length;
    const stateStr = stringifyState(input.state).toLowerCase();
    const instructionsStr = String(input.instructions || input.question || "").toLowerCase();
    let targetCenter = (numLevels - 1) * 0.5;
    const isHigh = CONCEPT_KEYWORDS.urgent.some((w) => wordMatch(stateStr, w)) || CONCEPT_KEYWORDS.toxicity.some((w) => wordMatch(stateStr, w)) || stateStr.includes("500") || stateStr.includes("fatal") || stateStr.includes("unacceptable") || stateStr.includes("severe");
    const isLow = CONCEPT_KEYWORDS.low.some((w) => wordMatch(stateStr, w)) || stateStr.includes("trivial") || stateStr.includes("minor") || stateStr.includes("routine");
    const isMedium = CONCEPT_KEYWORDS.moderate.some((w) => wordMatch(stateStr, w)) || CONCEPT_KEYWORDS.bug.some((w) => wordMatch(stateStr, w));
    if (isHigh) {
      targetCenter = numLevels - 1;
    } else if (isLow) {
      targetCenter = 0;
    } else if (isMedium) {
      targetCenter = (numLevels - 1) * 0.5;
    } else {
      let bestMatchIdx = -1;
      let bestMatchScore = 0;
      for (const lvl of levels) {
        const descWords = extractKeywords(lvl.description + " " + lvl.key);
        let s = 0;
        for (const w of descWords) {
          if (wordMatch(stateStr, w)) s++;
        }
        if (s > bestMatchScore) {
          bestMatchScore = s;
          bestMatchIdx = lvl.index;
        }
      }
      if (bestMatchIdx >= 0) {
        targetCenter = bestMatchIdx;
      }
    }
    if (instructionsStr.includes("safe") || instructionsStr.includes("quality") || instructionsStr.includes("satisfaction")) {
      const isPositive = CONCEPT_KEYWORDS.positive.some((w) => wordMatch(stateStr, w));
      const isNegative = CONCEPT_KEYWORDS.negative.some((w) => wordMatch(stateStr, w));
      if (isPositive) targetCenter = numLevels - 1;
      else if (isNegative) targetCenter = 0;
    }
    const rawWeights = [];
    let totalWeight = 0;
    for (let i = 0; i < numLevels; i++) {
      const dist = Math.abs(i - targetCenter);
      const weight = Math.exp(-1.5 * dist * dist) + 0.05;
      rawWeights.push(weight);
      totalWeight += weight;
    }
    const probabilities = {};
    let weightedScore = 0;
    let maxProb = 0;
    for (let i = 0; i < numLevels; i++) {
      const lvl = levels[i];
      const normProb = Number((rawWeights[i] / totalWeight).toFixed(2));
      probabilities[lvl.key] = normProb;
      if (lvl.key !== String(lvl.index)) {
        probabilities[String(lvl.index)] = normProb;
      }
      weightedScore += lvl.index * normProb;
      if (normProb > maxProb) maxProb = normProb;
    }
    const confidence = Number(Math.min(0.98, Math.max(0.55, maxProb * 1.05)).toFixed(2));
    const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
    return {
      score: Number(weightedScore.toFixed(2)),
      confidence,
      probabilities,
      latencyMs
    };
  }
  dispose() {
    this._isLoaded = false;
  }
};
var OpenJevWllamaEngine = class {
  model;
  isHeuristic = false;
  _isLoaded = false;
  options;
  modelUrl;
  wllamaInstance = null;
  constructor(options = {}) {
    const validated = validateModelOptions(options);
    this.model = validated.modelId;
    this.modelUrl = validated.modelUrl;
    this.options = options;
  }
  get isLoaded() {
    return this._isLoaded;
  }
  async init() {
    if (this._isLoaded && this.wllamaInstance) return;
    const onProgress = this.options.onProgress;
    onProgress?.({
      status: "downloading",
      loaded: 0,
      total: 100,
      percent: 0,
      detail: `Downloading OpenJev model ${this.model}`
    });
    let WllamaClass = null;
    try {
      const mod = await import("@wllama/wllama/esm/index.js");
      WllamaClass = mod.Wllama || mod.default?.Wllama || mod.default;
    } catch {
      const mod = await import("@wllama/wllama");
      WllamaClass = mod.Wllama || mod.default?.Wllama || mod.default;
    }
    if (!WllamaClass) {
      throw new Error("@wllama/wllama could not be loaded in this environment");
    }
    const pathConfig = this.options.wasmPaths || {
      default: "https://cdn.jsdelivr.net/npm/@wllama/wllama@3.6.1/esm/wllama.wasm",
      "single-thread/wllama.wasm": "https://cdn.jsdelivr.net/npm/@wllama/wllama@3.6.1/esm/single-thread/wllama.wasm",
      "multi-thread/wllama.wasm": "https://cdn.jsdelivr.net/npm/@wllama/wllama@3.6.1/esm/multi-thread/wllama.wasm"
    };
    this.wllamaInstance = new WllamaClass(pathConfig, {
      suppressNativeLog: true
    });
    onProgress?.({
      status: "loading",
      loaded: 40,
      total: 100,
      percent: 40,
      detail: "Initializing runtime context"
    });
    await this.wllamaInstance.loadModelFromUrl(this.modelUrl, {
      useCache: true,
      onProgress: (p) => {
        const percent = p.total > 0 ? Math.round(p.loaded / p.total * 100) : 50;
        onProgress?.({
          status: "downloading",
          loaded: p.loaded,
          total: p.total,
          percent,
          detail: `Loading model shards (${percent}%)`
        });
      }
    });
    onProgress?.({
      status: "ready",
      loaded: 100,
      total: 100,
      percent: 100,
      detail: `OpenJev model ${this.model} initialized`
    });
    this._isLoaded = true;
  }
  async choice(input) {
    const startTime = performance.now();
    await this.init();
    const normOptions = normalizeOptions(input.options);
    const stateStr = stringifyState(input.state);
    const question = input.question || input.instructions || "Select the most appropriate option";
    const prompt = `Context:
${stateStr}

Question: ${question}
Choices:
${normOptions.map((opt, idx) => `(${idx + 1}) ${opt.key}: ${opt.description}`).join("\n")}

Answer:`;
    const res = await this.wllamaInstance.createCompletion({
      prompt,
      max_tokens: 1,
      temperature: 0,
      logprobs: true,
      top_logprobs: Math.max(10, normOptions.length * 2)
    });
    const probabilities = {};
    const textOut = (res?.text || "").trim().toLowerCase();
    let winningChoice = normOptions[0].key;
    let maxScore = -Infinity;
    const topLogprobs = res?.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs || [];
    if (topLogprobs.length > 0) {
      let sumExp = 0;
      const rawExp = {};
      for (const opt of normOptions) {
        const keyLower = opt.key.toLowerCase();
        let bestLp = -20;
        for (const lp of topLogprobs) {
          const t = (lp.token || "").trim().toLowerCase();
          if (t.includes(keyLower) || keyLower.includes(t)) {
            if (lp.logprob > bestLp) bestLp = lp.logprob;
          }
        }
        const expVal = Math.exp(bestLp);
        rawExp[opt.key] = expVal;
        sumExp += expVal;
      }
      for (const opt of normOptions) {
        const prob = sumExp > 0 ? Number((rawExp[opt.key] / sumExp).toFixed(2)) : Number((1 / normOptions.length).toFixed(2));
        probabilities[opt.key] = prob;
        if (prob > maxScore) {
          maxScore = prob;
          winningChoice = opt.key;
        }
      }
    } else {
      for (let i = 0; i < normOptions.length; i++) {
        const opt = normOptions[i];
        const isMatch = textOut.includes(opt.key.toLowerCase()) || textOut.includes(String(i + 1));
        const prob = isMatch ? 0.85 : Number((0.15 / Math.max(normOptions.length - 1, 1)).toFixed(2));
        probabilities[opt.key] = prob;
        if (prob > maxScore) {
          maxScore = prob;
          winningChoice = opt.key;
        }
      }
    }
    const confidence = Number(Math.max(0.51, Math.min(0.99, maxScore)).toFixed(2));
    const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
    return {
      choice: winningChoice,
      confidence,
      probabilities,
      latencyMs
    };
  }
  async directChoice(input) {
    return this.choice(input);
  }
  async noul(input) {
    const startTime = performance.now();
    await this.init();
    const statement = String(input.statement || input.instructions || "").trim();
    if (!statement) {
      throw new Error("statement is required for noul evaluation");
    }
    const threshold = input.threshold ?? this.options.noulThreshold ?? 0.5;
    const stateStr = stringifyState(input.state);
    const prompt = `Context:
${stateStr}

Statement: ${statement}
Does the statement hold true? Answer Yes or No:
Answer:`;
    const res = await this.wllamaInstance.createCompletion({
      prompt,
      max_tokens: 1,
      temperature: 0,
      logprobs: true,
      top_logprobs: 10
    });
    const topLogprobs = res?.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs || [];
    let pYes = 0.5;
    if (topLogprobs.length > 0) {
      let lpYes = -20;
      let lpNo = -20;
      for (const lp of topLogprobs) {
        const t = (lp.token || "").trim().toLowerCase();
        if (t === "yes" || t === "true") lpYes = Math.max(lpYes, lp.logprob);
        if (t === "no" || t === "false") lpNo = Math.max(lpNo, lp.logprob);
      }
      const expYes = Math.exp(lpYes);
      const expNo = Math.exp(lpNo);
      pYes = expYes / (expYes + expNo || 1);
    } else {
      const text = (res?.text || "").trim().toLowerCase();
      pYes = text.startsWith("y") || text.startsWith("t") ? 0.9 : 0.1;
    }
    const noulVal = Number(Math.min(0.99, Math.max(0.01, pYes)).toFixed(2));
    const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
    return {
      noul: noulVal,
      passed: noulVal >= threshold,
      latencyMs
    };
  }
  async score(input) {
    const startTime = performance.now();
    await this.init();
    const levels = normalizeCriteria(input.criteria);
    const numLevels = levels.length;
    const stateStr = stringifyState(input.state);
    const instructions = input.instructions || input.question || "Score the situation along ordered levels";
    const prompt = `Context:
${stateStr}

Instructions: ${instructions}
Levels:
${levels.map((l) => `(${l.index}) ${l.key}: ${l.description}`).join("\n")}

Best matching level number (0-${numLevels - 1}):`;
    const res = await this.wllamaInstance.createCompletion({
      prompt,
      max_tokens: 1,
      temperature: 0,
      logprobs: true,
      top_logprobs: Math.max(10, numLevels * 2)
    });
    const topLogprobs = res?.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs || [];
    const probabilities = {};
    let weightedScore = 0;
    let maxProb = 0;
    if (topLogprobs.length > 0) {
      const rawExp = [];
      let totalExp = 0;
      for (let i = 0; i < numLevels; i++) {
        const lvl = levels[i];
        let bestLp = -20;
        for (const lp of topLogprobs) {
          const t = (lp.token || "").trim().toLowerCase();
          if (t === String(i) || t === lvl.key.toLowerCase()) {
            bestLp = Math.max(bestLp, lp.logprob);
          }
        }
        const expVal = Math.exp(bestLp);
        rawExp.push(expVal);
        totalExp += expVal;
      }
      for (let i = 0; i < numLevels; i++) {
        const lvl = levels[i];
        const prob = totalExp > 0 ? Number((rawExp[i] / totalExp).toFixed(2)) : Number((1 / numLevels).toFixed(2));
        probabilities[lvl.key] = prob;
        if (lvl.key !== String(lvl.index)) {
          probabilities[String(lvl.index)] = prob;
        }
        weightedScore += lvl.index * prob;
        if (prob > maxProb) maxProb = prob;
      }
    } else {
      const text = (res?.text || "").trim();
      const matchedIdx = parseInt(text, 10);
      const center = !isNaN(matchedIdx) && matchedIdx >= 0 && matchedIdx < numLevels ? matchedIdx : Math.floor(numLevels / 2);
      for (let i = 0; i < numLevels; i++) {
        const lvl = levels[i];
        const prob = i === center ? 0.85 : Number((0.15 / Math.max(numLevels - 1, 1)).toFixed(2));
        probabilities[lvl.key] = prob;
        if (lvl.key !== String(lvl.index)) {
          probabilities[String(lvl.index)] = prob;
        }
        weightedScore += lvl.index * prob;
        if (prob > maxProb) maxProb = prob;
      }
    }
    const confidence = Number(Math.max(0.55, Math.min(0.98, maxProb * 1.05)).toFixed(2));
    const latencyMs = Math.max(1, Math.round(performance.now() - startTime));
    return {
      score: Number(weightedScore.toFixed(2)),
      confidence,
      probabilities,
      latencyMs
    };
  }
  async dispose() {
    if (this.wllamaInstance) {
      try {
        await this.wllamaInstance.exit();
      } catch {
      }
      this.wllamaInstance = null;
    }
    this._isLoaded = false;
  }
};
function isWllamaSupported() {
  const isBrowser = typeof window !== "undefined";
  const isWorker = typeof WorkerGlobalScope !== "undefined" || typeof self !== "undefined" && typeof self.postMessage === "function";
  return (isBrowser || isWorker) && typeof WebAssembly !== "undefined";
}
function createDecisionEngine(options = {}) {
  const mode = options.mode ?? "auto";
  if (mode === "heuristic") {
    return new HeuristicDecisionEngine(options);
  }
  if (mode === "wllama") {
    return new OpenJevWllamaEngine(options);
  }
  if (isWllamaSupported()) {
    return new OpenJevWllamaEngine(options);
  }
  return new HeuristicDecisionEngine(options);
}
async function directChoice(input, options) {
  const engine = createDecisionEngine(options);
  await engine.init();
  return engine.choice(input);
}

// src/loader.ts
async function inferTask(modelId) {
  const lower = modelId.toLowerCase();
  if (lower.includes("openjev") || lower.includes("jev") || lower.includes("decision") || lower === "minicpm5-2b" || lower === "qwen3-0.6b" || lower === "qwen3.5-4b") {
    return "decision";
  }
  if (lower.includes("kokoro") || lower.includes("speecht5") || lower.includes("mms-tts") || lower.includes("tts")) {
    return "text-to-speech";
  }
  if (lower.includes("whisper") || lower.includes("asr") || lower.includes("speech") || lower.includes("sushrota") || lower.includes("parakeet")) {
    return "automatic-speech-recognition";
  }
  if (lower.includes("llama") || lower.includes("qwen") || lower.includes("gpt") || lower.includes("mistral") || lower.includes("phi") || lower.includes("gemma") || lower.includes("bonsai")) {
    return "text-generation";
  }
  if (lower.includes("detr") || lower.includes("yolo")) {
    return "object-detection";
  }
  if (lower.includes("vit") || lower.includes("resnet") || lower.includes("mobilenet")) {
    return "image-classification";
  }
  if (lower.includes("minilm") || lower.includes("bge") || lower.includes("embed")) {
    return "feature-extraction";
  }
  if (lower.endsWith(".onnx")) {
    return "raw-onnx";
  }
  try {
    const info = await getModelInfo(modelId);
    if (info.task && info.task !== "unknown") {
      return info.task;
    }
    const tags = info.tags || [];
    if (tags.includes("automatic-speech-recognition") || tags.includes("audio")) {
      return "automatic-speech-recognition";
    }
    if (tags.includes("text-generation")) {
      return "text-generation";
    }
    if (tags.includes("image-classification")) {
      return "image-classification";
    }
  } catch {
  }
  return "text-generation";
}
async function webmlImpl(modelId, options = {}) {
  const task = options.task ?? await inferTask(modelId);
  if (task === "decision") {
    const engine = createDecisionEngine({
      model: modelId,
      onProgress: options.onProgress ? (e) => options.onProgress?.({
        status: e.status,
        loaded: e.loaded,
        total: e.total,
        percent: e.percent,
        file: e.detail
      }) : void 0
    });
    await engine.init();
    const runner2 = async (input, runOptions) => {
      if (typeof input === "object" && input !== null && "options" in input) {
        return engine.choice(input);
      }
      if (typeof input === "object" && input !== null && "statement" in input) {
        return engine.noul(input);
      }
      if (typeof input === "object" && input !== null && "criteria" in input) {
        return engine.score(input);
      }
      return engine.choice({
        state: input,
        options: runOptions?.options || ["yes", "no"]
      });
    };
    const model2 = Object.assign(runner2, {
      task,
      modelId,
      client: null,
      run: async (input, runOptions) => {
        return runner2(input, runOptions);
      },
      dispose: () => {
        engine.dispose();
      },
      choice: (choiceInput) => engine.choice(choiceInput),
      directChoice: (choiceInput) => engine.directChoice(choiceInput),
      noul: (noulInput) => engine.noul(noulInput),
      score: (scoreInput) => engine.score(scoreInput),
      stream: () => {
        throw new Error("Streaming is not supported for decision models");
      },
      generate: async () => {
        throw new Error("generate is not supported for decision models; use choice() or score()");
      },
      transcribe: async () => {
        throw new Error("transcribe is not supported for decision models");
      },
      classify: async () => {
        throw new Error("Use choice() or score() for decision models");
      },
      embed: async () => {
        throw new Error("embed is not supported for decision models");
      },
      detect: async () => {
        throw new Error("detect is not supported for decision models");
      },
      listen: async () => {
        throw new Error("listen is not supported for decision models");
      }
    });
    return model2;
  }
  const client = new ModelClient(options.workerUrl);
  await client.load({
    task,
    modelId,
    dtype: options.dtype,
    device: options.device,
    revision: options.revision,
    onProgress: options.onProgress
  });
  const runner = async (input, runOptions) => {
    if (task === "automatic-speech-recognition") {
      const pcm = await coerceAudio(input);
      return client.run("automatic-speech-recognition", pcm, runOptions);
    }
    return client.run(task, input, runOptions);
  };
  const model = Object.assign(runner, {
    task,
    modelId,
    client,
    run: (input, runOptions) => {
      return runner(input, runOptions);
    },
    dispose: () => {
      client.dispose();
      client.terminate();
    },
    stream: (input, genOptions) => {
      return client.stream(input, genOptions);
    },
    generate: (input, genOptions) => {
      return client.generate(input, genOptions);
    },
    transcribe: async (input, runOptions) => {
      const pcm = await coerceAudio(input);
      return client.run("automatic-speech-recognition", pcm, runOptions);
    },
    classify: (input, runOptions) => {
      return client.run("image-classification", input, runOptions);
    },
    embed: (input, runOptions) => {
      return client.run("feature-extraction", input, runOptions);
    },
    detect: (input, runOptions) => {
      return client.run("object-detection", input, runOptions);
    },
    listen: async (listenOptions) => {
      return listenMic(
        async (pcm) => {
          try {
            const res = await client.run("automatic-speech-recognition", pcm);
            if (res?.text?.trim()) {
              listenOptions.onTranscript(res.text.trim());
            }
          } catch (err) {
            console.warn("Transcription error during mic listen:", err);
          }
        },
        { intervalSeconds: listenOptions.intervalSeconds }
      );
    }
  });
  return model;
}
var webml = Object.assign(webmlImpl, {
  decision: (options) => {
    return createDecisionEngine(options);
  },
  directChoice: (input, options) => {
    return directChoice(input, options);
  }
});
var loader_default = webml;

// src/device.ts
var VRAM_THRESHOLDS = [
  { min: 8 * 1024 ** 3, dtype: "fp16" },
  // 8 GB+  → fp16
  { min: 4 * 1024 ** 3, dtype: "q8" },
  // 4 GB+  → q8
  { min: 2 * 1024 ** 3, dtype: "q4" },
  // 2 GB+  → q4
  { min: 0, dtype: "q4" }
  // < 2 GB → q4 (safest)
];
async function getGPUAdapter() {
  if (typeof navigator === "undefined") return null;
  if (!("gpu" in navigator)) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance"
    });
    return adapter;
  } catch {
    return null;
  }
}
async function getGPUInfo(adapter) {
  const info = adapter.info ?? adapter.requestAdapterInfo?.();
  const resolved = info instanceof Promise ? await info : info;
  const vram = Number(adapter.limits?.maxBufferSize ?? 0);
  return {
    vendor: resolved?.vendor ?? "unknown",
    architecture: resolved?.architecture ?? "unknown",
    description: resolved?.description ?? "unknown",
    vram,
    vramFormatted: formatSize(vram)
  };
}
function recommendDtype(vram) {
  for (const { min, dtype } of VRAM_THRESHOLDS) {
    if (vram >= min) return dtype;
  }
  return "q4";
}
async function checkWebGPU() {
  const adapter = await getGPUAdapter();
  return adapter !== null;
}
function checkWASM() {
  return typeof WebAssembly !== "undefined";
}
async function detectDevice() {
  const adapter = await getGPUAdapter();
  if (adapter) {
    const gpu = await getGPUInfo(adapter);
    return {
      backend: "webgpu",
      gpu,
      recommendedDtype: recommendDtype(gpu.vram)
    };
  }
  if (checkWASM()) {
    return {
      backend: "wasm",
      gpu: null,
      recommendedDtype: "q4"
    };
  }
  return {
    backend: "cpu",
    gpu: null,
    recommendedDtype: "q4"
  };
}
var SIZE_UNITS = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4
};
function parseSize(input) {
  if (typeof input === "number") return input;
  const match = input.trim().match(/^([\d.]+)\s*(b|kb|mb|gb|tb)$/i);
  if (!match) {
    throw new Error(
      `Invalid size format: "${input}". Use something like "4GB", "512MB", or a number in bytes.`
    );
  }
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  return Math.round(value * SIZE_UNITS[unit]);
}
function formatSize(bytes) {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
async function canRun(estimatedSize) {
  const bytes = parseSize(estimatedSize);
  const device = await detectDevice();
  if (device.backend === "webgpu" && device.gpu) {
    const available = device.gpu.vram - 512 * 1024 ** 2;
    if (bytes > available) {
      return {
        ok: false,
        backend: device.backend,
        reason: `Model (~${formatSize(bytes)}) exceeds available VRAM (~${formatSize(available)})`
      };
    }
  }
  return { ok: true, backend: device.backend };
}

// src/cache.ts
var CACHE_PREFIXES = ["transformers-cache", "webml-kit"];
function isModelCache(name) {
  return CACHE_PREFIXES.some((prefix) => name.startsWith(prefix));
}
async function getCacheBackend() {
  if (typeof caches !== "undefined") {
    return "cache-api";
  }
  if (typeof navigator !== "undefined" && "storage" in navigator) {
    try {
      const root = await navigator.storage.getDirectory();
      if (root) return "opfs";
    } catch {
    }
  }
  if (typeof indexedDB !== "undefined") {
    return "indexeddb";
  }
  return "cache-api";
}
async function isCached(modelId) {
  if (typeof caches === "undefined") return false;
  try {
    const keys = await caches.keys();
    const matchedCaches = keys.filter((k) => isModelCache(k));
    for (const cacheName of matchedCaches) {
      const cache = await caches.open(cacheName);
      const cacheKeys = await cache.keys();
      const hasModel = cacheKeys.some(
        (req) => req.url.includes(encodeURIComponent(modelId)) || req.url.includes(modelId)
      );
      if (hasModel) return true;
    }
  } catch {
  }
  return false;
}
async function getCacheSize() {
  if (typeof navigator === "undefined" || !("storage" in navigator)) return 0;
  try {
    const estimate = await navigator.storage.estimate();
    return estimate.usage ?? 0;
  } catch {
    return 0;
  }
}
async function listCachedModels() {
  if (typeof caches === "undefined") return [];
  const models = [];
  try {
    const keys = await caches.keys();
    const matchedCaches = keys.filter((k) => isModelCache(k));
    for (const cacheName of matchedCaches) {
      const cache = await caches.open(cacheName);
      const cacheKeys = await cache.keys();
      const modelUrls = /* @__PURE__ */ new Map();
      for (const request of cacheKeys) {
        const url = request.url;
        const match = url.match(/huggingface\.co\/([^/]+\/[^/]+)\//);
        const id = match ? match[1] : url.split("/").filter(Boolean).slice(-2).join("/") || url;
        const response = await cache.match(request);
        const size = response ? Number(response.headers.get("content-length") ?? 0) : 0;
        modelUrls.set(id, (modelUrls.get(id) ?? 0) + size);
      }
      for (const [modelId, sizeBytes] of modelUrls) {
        models.push({
          modelId,
          sizeBytes,
          size: formatSize(sizeBytes),
          lastAccessed: /* @__PURE__ */ new Date()
          // Cache API doesn't track this
        });
      }
    }
  } catch {
  }
  return models;
}
async function clearCache(modelId) {
  if (typeof caches === "undefined") return;
  try {
    const keys = await caches.keys();
    const matchedCaches = keys.filter((k) => isModelCache(k));
    for (const cacheName of matchedCaches) {
      if (!modelId) {
        await caches.delete(cacheName);
      } else {
        const cache = await caches.open(cacheName);
        const cacheKeys = await cache.keys();
        for (const request of cacheKeys) {
          if (request.url.includes(encodeURIComponent(modelId)) || request.url.includes(modelId)) {
            await cache.delete(request);
          }
        }
      }
    }
  } catch {
  }
}

// src/pipelines/index.ts
var PIPELINE_REGISTRY = {
  "text-generation": {
    defaultModel: "onnx-community/Llama-3.2-1B-Instruct-ONNX",
    defaultDtype: "q4",
    supportsStreaming: true,
    usesKVCache: true
  },
  "text-classification": {
    defaultModel: "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
    defaultDtype: "q8",
    supportsStreaming: false,
    usesKVCache: false
  },
  "image-classification": {
    defaultModel: "Xenova/vit-base-patch16-224",
    defaultDtype: "fp32",
    supportsStreaming: false,
    usesKVCache: false
  },
  "object-detection": {
    defaultModel: "Xenova/detr-resnet-50",
    defaultDtype: "fp32",
    supportsStreaming: false,
    usesKVCache: false
  },
  "automatic-speech-recognition": {
    defaultModel: "onnx-community/whisper-tiny.en",
    defaultDtype: "q8",
    supportsStreaming: false,
    usesKVCache: false
  },
  "text-to-speech": {
    defaultModel: "onnx-community/Kokoro-82M-v1.0-ONNX",
    defaultDtype: "q8",
    supportsStreaming: false,
    usesKVCache: false
  },
  "translation": {
    defaultModel: "Xenova/nllb-200-distilled-600M",
    defaultDtype: "q8",
    supportsStreaming: false,
    usesKVCache: false
  },
  "summarization": {
    defaultModel: "Xenova/distilbart-cnn-6-6",
    defaultDtype: "q8",
    supportsStreaming: false,
    usesKVCache: false
  },
  "feature-extraction": {
    defaultModel: "Xenova/all-MiniLM-L6-v2",
    defaultDtype: "fp32",
    supportsStreaming: false,
    usesKVCache: false
  },
  "image-to-text": {
    defaultModel: "Xenova/vit-gpt2-image-captioning",
    defaultDtype: "q8",
    supportsStreaming: false,
    usesKVCache: false
  },
  "zero-shot-classification": {
    defaultModel: "Xenova/mobilebert-uncased-mnli",
    defaultDtype: "q8",
    supportsStreaming: false,
    usesKVCache: false
  },
  "fill-mask": {
    defaultModel: "Xenova/bert-base-uncased",
    defaultDtype: "q8",
    supportsStreaming: false,
    usesKVCache: false
  },
  "question-answering": {
    defaultModel: "Xenova/distilbert-base-uncased-distilled-squad",
    defaultDtype: "q8",
    supportsStreaming: false,
    usesKVCache: false
  },
  "token-classification": {
    defaultModel: "Xenova/bert-base-NER",
    defaultDtype: "q8",
    supportsStreaming: false,
    usesKVCache: false
  },
  "depth-estimation": {
    defaultModel: "Xenova/depth-anything-small-hf",
    defaultDtype: "fp32",
    supportsStreaming: false,
    usesKVCache: false
  },
  "image-segmentation": {
    defaultModel: "Xenova/detr-resnet-50-panoptic",
    defaultDtype: "fp32",
    supportsStreaming: false,
    usesKVCache: false
  },
  "raw-onnx": {
    defaultModel: "",
    defaultDtype: "fp32",
    supportsStreaming: false,
    usesKVCache: false
  },
  "decision": {
    defaultModel: "qwen3-0.6b",
    defaultDtype: "q4",
    supportsStreaming: false,
    usesKVCache: false
  },
  "custom": {
    defaultModel: "",
    defaultDtype: "fp32",
    supportsStreaming: false,
    usesKVCache: false
  }
};
function getPipelineDefaults(task) {
  const defaults = PIPELINE_REGISTRY[task];
  if (!defaults) {
    throw new Error(`Unknown pipeline task: ${task}`);
  }
  return defaults;
}
function supportsStreaming(task) {
  return PIPELINE_REGISTRY[task]?.supportsStreaming ?? false;
}

// src/index.ts
var index_default = loader_default;
export {
  GPURecovery,
  HeuristicDecisionEngine,
  ModelClient,
  OPENJEV_MODELS,
  OpenJevWllamaEngine,
  PIPELINE_REGISTRY,
  TokenStream,
  WEBGPU_ORGS,
  canRun,
  checkWASM,
  checkWebGPU,
  clearCache,
  coerceAudio,
  collectStream,
  createDecisionEngine,
  createOnnxPipeline,
  decodeCTC,
  decodeWavToFloat32,
  index_default as default,
  detectDevice,
  directChoice,
  formatSize,
  getCacheBackend,
  getCacheSize,
  getGPUAdapter,
  getGPUInfo,
  getModelInfo,
  getPipelineDefaults,
  inferTask,
  isCached,
  listCachedModels,
  listModelsForTask,
  listWebGPUModels,
  listenMic,
  normalizeCriteria,
  normalizeOptions,
  parseSize,
  recommendDtype,
  searchModels,
  supportsStreaming,
  toFloat32Array,
  trendingModels,
  validateModelOptions,
  webml
};
