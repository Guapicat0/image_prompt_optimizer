const $ = (id) => document.getElementById(id);

const STORAGE_KEYS = {
  imageBaseUrl: "ipo.imageBaseUrl",
  imageApiKey: "ipo.imageApiKey",
  imageModel: "ipo.imageModel",
  chatBaseUrl: "ipo.chatBaseUrl",
  chatApiKey: "ipo.chatApiKey",
  chatModel: "ipo.chatModel",
  imageModels: "ipo.imageModels",
  chatModels: "ipo.chatModels",
  legacyHistory: "ipo.history",
};

const DB_NAME = "imagePromptOptimizer";
const DB_VERSION = 1;
const HISTORY_STORE = "history";
const HISTORY_PAGE_SIZE = 20;
const MAX_HISTORY_ROWS = 500;
const MAX_PROMPT_CHARS = 2400;
const MAX_ERROR_CHARS = 1800;

const state = {
  file: null,
  imageBase64: "",
  mimeType: "",
  previewUrl: "",
  imageModels: [],
  chatModels: [],
  db: null,
  historyOffset: 0,
  historyTotal: 0,
};

const imageExtMime = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  dng: "image/x-adobe-dng",
  raw: "application/octet-stream",
  cr2: "image/x-canon-cr2",
  nef: "image/x-nikon-nef",
  arw: "image/x-sony-arw",
  rw2: "image/x-panasonic-rw2",
  orf: "image/x-olympus-orf",
  raf: "image/x-fuji-raf",
};

function setBox(id, message) {
  const box = $(id);
  box.style.display = message ? "block" : "none";
  box.textContent = message || "";
}

function setBusy(button, busy, busyText) {
  if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.idleText;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} 秒`;
}

function nowText() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function requireValue(id, label) {
  const value = $(id).value.trim();
  if (!value) throw new Error(`请填写${label}`);
  return value;
}

function selectedValue(id, label) {
  const value = $(id).value.trim();
  if (!value) throw new Error(`请先选择${label}`);
  return value;
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

async function apiJson(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 240000);
  try {
    const response = await fetch(path, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时，请检查中转服务或稍后重试。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function modelName(model) {
  return typeof model === "string" ? model : model?.id;
}

function renderModelSelect(selectId, models, savedKey) {
  const select = $(selectId);
  select.innerHTML = models.length
    ? models.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("")
    : `<option value="">请先在第 1 步测试服务</option>`;
  const saved = localStorage.getItem(savedKey);
  if (saved && models.includes(saved)) select.value = saved;
}

function saveSettings() {
  for (const id of ["imageBaseUrl", "imageApiKey", "chatBaseUrl", "chatApiKey"]) {
    localStorage.setItem(STORAGE_KEYS[id], $(id).value);
  }
  if ($("imageModel").value) localStorage.setItem(STORAGE_KEYS.imageModel, $("imageModel").value);
  if ($("chatModel").value) localStorage.setItem(STORAGE_KEYS.chatModel, $("chatModel").value);
}

function restoreSettings() {
  $("imageBaseUrl").value = localStorage.getItem(STORAGE_KEYS.imageBaseUrl) || "https://www.cctq.ai/v1";
  $("chatBaseUrl").value = localStorage.getItem(STORAGE_KEYS.chatBaseUrl) || "https://www.cctq.ai/v1";
  $("imageApiKey").value = localStorage.getItem(STORAGE_KEYS.imageApiKey) || "";
  $("chatApiKey").value = localStorage.getItem(STORAGE_KEYS.chatApiKey) || "";

  state.imageModels = JSON.parse(localStorage.getItem(STORAGE_KEYS.imageModels) || "[]");
  state.chatModels = JSON.parse(localStorage.getItem(STORAGE_KEYS.chatModels) || "[]");
  renderModelSelect("imageModel", state.imageModels, STORAGE_KEYS.imageModel);
  renderModelSelect("chatModel", state.chatModels, STORAGE_KEYS.chatModel);

  for (const id of ["imageBaseUrl", "imageApiKey", "chatBaseUrl", "chatApiKey", "imageModel", "chatModel"]) {
    $(id).addEventListener("input", saveSettings);
    $(id).addEventListener("change", saveSettings);
  }
}

function openHistoryDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HISTORY_STORE)) {
        const store = db.createObjectStore(HISTORY_STORE, { keyPath: "id" });
        store.createIndex("createdAtMs", "createdAtMs", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txStore(mode = "readonly") {
  return state.db.transaction(HISTORY_STORE, mode).objectStore(HISTORY_STORE);
}

async function migrateLegacyHistory() {
  const legacy = localStorage.getItem(STORAGE_KEYS.legacyHistory);
  if (!legacy) return;
  try {
    const rows = JSON.parse(legacy);
    if (Array.isArray(rows)) {
      for (const row of rows.slice(0, 50)) await addHistory(row, false);
    }
  } catch {}
  localStorage.removeItem(STORAGE_KEYS.legacyHistory);
}

function storeCount() {
  return new Promise((resolve) => {
    const request = txStore().count();
    request.onsuccess = () => resolve(request.result || 0);
    request.onerror = () => resolve(0);
  });
}

async function addHistory(entry, refresh = true) {
  if (!state.db) return;
  const row = {
    id: entry.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAtMs: Date.now(),
    createdAt: entry.createdAt || nowText(),
    action: entry.action || "",
    status: entry.status || "",
    model: entry.model || "",
    fileName: entry.fileName || "",
    duration: entry.duration || "",
    prompt: truncate(entry.prompt, MAX_PROMPT_CHARS),
    error: truncate(entry.error, MAX_ERROR_CHARS),
  };

  await new Promise((resolve) => {
    const request = txStore("readwrite").put(row);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
  cleanupHistory().catch(() => {});
  if (refresh && $("historyPanel").classList.contains("isOpen")) await resetHistoryView();
}

async function cleanupHistory() {
  const count = await storeCount();
  if (count <= MAX_HISTORY_ROWS) return;
  const removeCount = count - MAX_HISTORY_ROWS;
  await new Promise((resolve) => {
    const index = txStore("readwrite").index("createdAtMs");
    const request = index.openCursor();
    let removed = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || removed >= removeCount) return resolve();
      cursor.delete();
      removed += 1;
      cursor.continue();
    };
    request.onerror = () => resolve();
  });
}

function readHistoryPage(offset, limit) {
  return new Promise((resolve) => {
    const rows = [];
    const index = txStore().index("createdAtMs");
    const request = index.openCursor(null, "prev");
    let skipped = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || rows.length >= limit) return resolve(rows);
      if (skipped < offset) {
        skipped += 1;
        cursor.continue();
        return;
      }
      rows.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => resolve(rows);
  });
}

function renderHistoryRows(rows, append) {
  if (!append) $("historyList").innerHTML = "";
  if (!rows.length && !append) {
    $("historyList").innerHTML = `<div class="historyItem"><p>暂无历史记录。</p></div>`;
    return;
  }
  const html = rows.map((item) => {
    const errorHtml = item.error ? `<p><strong>失败原因：</strong>${escapeHtml(item.error)}</p>` : "";
    const promptHtml = item.prompt ? `<p><strong>提示词：</strong>${escapeHtml(item.prompt)}</p>` : "";
    return `<article class="historyItem">
      <header>
        <span><strong>${escapeHtml(item.action)}</strong> · ${escapeHtml(item.status)}</span>
        <span>${escapeHtml(item.createdAt)} · 耗时 ${escapeHtml(item.duration || "-")}</span>
      </header>
      <p><strong>模型：</strong>${escapeHtml(item.model || "-")}　<strong>文件：</strong>${escapeHtml(item.fileName || "-")}</p>
      ${promptHtml}
      ${errorHtml}
    </article>`;
  }).join("");
  $("historyList").insertAdjacentHTML("beforeend", html);
}

async function resetHistoryView() {
  state.historyOffset = 0;
  state.historyTotal = await storeCount();
  $("historySummary").textContent = `共 ${state.historyTotal} 条记录，按时间倒序显示。`;
  const rows = await readHistoryPage(0, HISTORY_PAGE_SIZE);
  state.historyOffset = rows.length;
  renderHistoryRows(rows, false);
  $("loadMoreHistoryBtn").style.display = state.historyOffset < state.historyTotal ? "inline-flex" : "none";
}

async function loadMoreHistory() {
  const rows = await readHistoryPage(state.historyOffset, HISTORY_PAGE_SIZE);
  state.historyOffset += rows.length;
  renderHistoryRows(rows, true);
  $("loadMoreHistoryBtn").style.display = state.historyOffset < state.historyTotal ? "inline-flex" : "none";
}

async function clearHistory() {
  if (!state.db) return;
  await new Promise((resolve) => {
    const request = txStore("readwrite").clear();
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
  await resetHistoryView();
}

async function pingService(kind, silent = false) {
  const isImage = kind === "image";
  const baseId = isImage ? "imageBaseUrl" : "chatBaseUrl";
  const keyId = isImage ? "imageApiKey" : "chatApiKey";
  const pingId = isImage ? "imagePing" : "chatPing";
  const buttonId = isImage ? "testImageService" : "testChatService";
  const selectId = isImage ? "imageModel" : "chatModel";
  const modelsKey = isImage ? STORAGE_KEYS.imageModels : STORAGE_KEYS.chatModels;
  const savedModelKey = isImage ? STORAGE_KEYS.imageModel : STORAGE_KEYS.chatModel;
  const label = isImage ? "绘图服务" : "对话服务";
  const button = $(buttonId);

  setBusy(button, true, "测试中...");
  $(pingId).textContent = "测试中...";
  try {
    const data = await apiJson("/api/ping", {
      headers: {
        "X-Base-URL": requireValue(baseId, `${label} URL`),
        "X-API-Key": requireValue(keyId, `${label} API Key`),
      },
      timeoutMs: 20000,
    });
    const models = (data.models || []).map(modelName).filter(Boolean).sort();
    if (isImage) state.imageModels = models;
    else state.chatModels = models;
    localStorage.setItem(modelsKey, JSON.stringify(models));
    renderModelSelect(selectId, models, savedModelKey);
    saveSettings();
    $(pingId).textContent = `联通，ping ${data.pingMs} ms，发现 ${models.length} 个模型`;
    $(pingId).className = "pingText ok";
    return true;
  } catch (error) {
    $(pingId).textContent = `${label}失败：${error.message}`;
    $(pingId).className = "pingText fail";
    if (!silent) throw error;
    return false;
  } finally {
    setBusy(button, false);
  }
}

function extractResponseText(response) {
  if (response.choices?.[0]?.message?.content) return response.choices[0].message.content;
  if (response.output_text) return response.output_text;
  const chunks = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function parseAnalysis(response) {
  const text = extractResponseText(response);
  try {
    return JSON.parse(text);
  } catch {
    return {
      issues: ["模型没有返回标准 JSON，已保留原文。"],
      editing_prompt: text,
      negative_prompt: "",
      rationale: "",
    };
  }
}

function imageDataFromEditResponse(response) {
  const item = response.data && response.data[0];
  if (!item) throw new Error("绘图接口没有返回图像数据");
  if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item.url) return item.url;
  throw new Error("绘图接口返回格式无法识别");
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

function inferMime(file) {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop().toLowerCase();
  return imageExtMime[ext] || "application/octet-stream";
}

function composeDefaultEditPrompt() {
  const prompt = $("prompt").value.trim();
  const negative = $("negative").value.trim();
  return negative ? `${prompt}\n\n避免：${negative}` : prompt;
}

$("fileInput").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  setBox("analysisError", "");
  setBox("editError", "");
  state.file = file;
  state.mimeType = inferMime(file);
  state.imageBase64 = await readFile(file);
  $("fileMeta").textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB · ${state.mimeType}`;

  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  const canPreview = state.mimeType === "image/jpeg" || state.mimeType === "image/png";
  $("preview").style.display = canPreview ? "block" : "none";
  $("rawNotice").style.display = canPreview ? "none" : "block";
  if (canPreview) {
    state.previewUrl = URL.createObjectURL(file);
    $("preview").src = state.previewUrl;
  }
});

$("testImageService").addEventListener("click", () => {
  setBox("editError", "");
  pingService("image").catch((error) => setBox("editError", `绘图服务测试失败：${error.message}`));
});

$("testChatService").addEventListener("click", () => {
  setBox("analysisError", "");
  pingService("chat").catch((error) => setBox("analysisError", `对话服务测试失败：${error.message}`));
});

$("analyzeBtn").addEventListener("click", async () => {
  if (!state.file) return setBox("analysisError", "请先选择图像");
  setBusy($("analyzeBtn"), true, "分析中...");
  setBox("analysisError", "");
  $("analysisMeta").textContent = "正在分析图像...";
  const started = performance.now();
  let model = "";
  try {
    model = selectedValue("chatModel", "对话模型");
    const response = await apiJson("/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Base-URL": requireValue("chatBaseUrl", "对话服务 URL"),
        "X-API-Key": requireValue("chatApiKey", "对话 API Key"),
      },
      body: JSON.stringify({
        model,
        fileName: state.file.name,
        mimeType: state.mimeType,
        imageBase64: state.imageBase64,
      }),
      timeoutMs: 300000,
    });
    const duration = formatDuration(Math.round(performance.now() - started));
    const analysis = parseAnalysis(response);
    $("issues").value = [
      ...(analysis.issues || []).map((item, index) => `${index + 1}. ${item}`),
      analysis.rationale ? `\n优化思路：${analysis.rationale}` : "",
    ].join("\n");
    $("prompt").value = analysis.editing_prompt || "";
    $("negative").value = analysis.negative_prompt || "";
    $("editPrompt").value = composeDefaultEditPrompt();
    $("analysisMeta").textContent = `完成时间：${nowText()} · 处理耗时：${duration}`;
    await addHistory({
      action: "分析并生成提示词",
      status: "成功",
      model,
      fileName: state.file.name,
      duration,
      prompt: analysis.editing_prompt || "",
    });
  } catch (error) {
    const duration = formatDuration(Math.round(performance.now() - started));
    $("analysisMeta").textContent = `失败时间：${nowText()} · 处理耗时：${duration}`;
    setBox("analysisError", `分析失败：${error.message}`);
    await addHistory({
      action: "分析并生成提示词",
      status: "失败",
      model,
      fileName: state.file?.name || "",
      duration,
      error: error.message,
    });
  } finally {
    setBusy($("analyzeBtn"), false);
  }
});

$("useDefaultPrompt").addEventListener("click", () => {
  const defaultPrompt = composeDefaultEditPrompt();
  if (!defaultPrompt) return setBox("editError", "第 3 步还没有生成可用的编辑提示词。");
  $("editPrompt").value = defaultPrompt;
  setBox("editError", "");
});

$("editBtn").addEventListener("click", async () => {
  if (!state.file) return setBox("editError", "请先选择图像");
  const editPrompt = $("editPrompt").value.trim();
  if (!editPrompt) return setBox("editError", "请先填写绘图提示词，或点击“使用第 3 步默认提示词”。");
  setBusy($("editBtn"), true, "生成中...");
  setBox("editError", "");
  $("editMeta").textContent = "正在调用绘图模型编辑图像...";
  const started = performance.now();
  let model = "";
  try {
    model = selectedValue("imageModel", "绘图模型");
    const response = await apiJson("/api/edit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Base-URL": requireValue("imageBaseUrl", "绘图服务 URL"),
        "X-API-Key": requireValue("imageApiKey", "绘图 API Key"),
      },
      body: JSON.stringify({
        model,
        prompt: editPrompt,
        fileName: state.file.name,
        mimeType: state.mimeType,
        imageBase64: state.imageBase64,
        size: $("size").value,
        quality: $("quality").value,
      }),
      timeoutMs: 360000,
    });
    const duration = formatDuration(Math.round(performance.now() - started));
    const src = imageDataFromEditResponse(response);
    $("resultImage").src = src;
    $("resultImage").style.display = "block";
    $("downloadLink").href = src;
    $("downloadLink").style.display = "inline-block";
    $("editMeta").textContent = `完成时间：${nowText()} · 处理耗时：${duration}`;
    await addHistory({
      action: "调用绘图模型编辑",
      status: "成功",
      model,
      fileName: state.file.name,
      duration,
      prompt: editPrompt,
    });
  } catch (error) {
    const duration = formatDuration(Math.round(performance.now() - started));
    $("editMeta").textContent = `失败时间：${nowText()} · 处理耗时：${duration}`;
    setBox("editError", `绘图编辑失败：${error.message}`);
    await addHistory({
      action: "调用绘图模型编辑",
      status: "失败",
      model,
      fileName: state.file?.name || "",
      duration,
      prompt: editPrompt,
      error: error.message,
    });
  } finally {
    setBusy($("editBtn"), false);
  }
});

$("historyBtn").addEventListener("click", async () => {
  $("historyPanel").classList.toggle("isOpen");
  if ($("historyPanel").classList.contains("isOpen")) await resetHistoryView();
});

$("loadMoreHistoryBtn").addEventListener("click", loadMoreHistory);

$("clearHistoryBtn").addEventListener("click", async () => {
  if (!confirm("确定清空所有历史记录吗？")) return;
  await clearHistory();
});

$("clearBtn").addEventListener("click", () => {
  $("fileInput").value = "";
  $("fileMeta").textContent = "尚未选择文件";
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = "";
  $("preview").removeAttribute("src");
  $("preview").style.display = "none";
  $("rawNotice").style.display = "none";
  $("issues").value = "";
  $("prompt").value = "";
  $("negative").value = "";
  $("editPrompt").value = "";
  $("resultImage").removeAttribute("src");
  $("resultImage").style.display = "none";
  $("downloadLink").style.display = "none";
  $("analysisMeta").textContent = "";
  $("editMeta").textContent = "";
  setBox("analysisError", "");
  setBox("editError", "");
  state.file = null;
  state.imageBase64 = "";
  state.mimeType = "";
});

async function init() {
  restoreSettings();
  try {
    state.db = await openHistoryDb();
    await migrateLegacyHistory();
    await resetHistoryView();
  } catch (error) {
    $("historySummary").textContent = `历史数据库不可用：${error.message}`;
  }
  if ($("imageApiKey").value.trim()) pingService("image", true);
  if ($("chatApiKey").value.trim()) pingService("chat", true);
}

init();
