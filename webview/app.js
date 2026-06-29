const $ = (id) => document.getElementById(id);
let settings = {};
let analysisImage = null;
let editImages = [];
let usingDefault = false;

function post(type, payload = {}) {
  chrome.webview.postMessage({ type, payload });
}

function setModels(id, models, selected) {
  const el = $(id);
  el.innerHTML = (models || []).map(m => `<option value="${escape(m)}">${escape(m)}</option>`).join("");
  if (selected) el.value = selected;
}

function escape(v) {
  return String(v || "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function activate(view) {
  document.querySelectorAll(".nav").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === `view-${view}`));
}

document.querySelectorAll(".nav").forEach(b => b.onclick = () => activate(b.dataset.view));

function collectSettings() {
  return {
    imageBaseUrl: $("imageBaseUrl").value,
    imageApiKey: $("imageApiKey").value,
    chatBaseUrl: $("chatBaseUrl").value,
    chatApiKey: $("chatApiKey").value,
    imageModel: $("imageModel").value,
    chatModel: $("chatModel").value,
    imageModels: [...$("imageModel").options].map(o => o.value),
    chatModels: [...$("chatModel").options].map(o => o.value),
  };
}

function renderHistory(items) {
  $("historyList").innerHTML = (items || []).map(x => `<div class="historyItem"><b>${escape(x.CreatedAt)}</b><br>${escape(x.Action)} · ${escape(x.Status)}<br>${escape(x.Model || "")}<br>${escape(x.FileName || "")}</div>`).join("");
}

function renderFiles() {
  $("analysisFiles").innerHTML = analysisImage ? `<div class="chip">${escape(analysisImage.name)}</div>` : "";
  $("editFiles").innerHTML = editImages.map((f, i) => `<div class="thumb"><img src="${f.dataUrl}"><span>${escape(f.name)}</span><button data-remove="${i}">移除</button></div>`).join("");
  document.querySelectorAll("[data-remove]").forEach(btn => btn.onclick = () => { editImages.splice(Number(btn.dataset.remove), 1); renderFiles(); });
}

function setDefaultPrompt() {
  if (usingDefault) {
    $("editPrompt").value = "";
    usingDefault = false;
    $("useDefault").textContent = "使用第 3 步默认提示词";
    return;
  }
  const prompt = $("prompt").value.trim();
  const negative = $("negative").value.trim();
  if (!prompt) return;
  $("editPrompt").value = negative ? `${prompt}\n\n避免：${negative}` : prompt;
  usingDefault = true;
  $("useDefault").textContent = "取消使用第 3 步默认提示词";
}

$("useDefault").onclick = setDefaultPrompt;
$("testImage").onclick = () => post("ping", { kind: "image", settings: collectSettings() });
$("testChat").onclick = () => post("ping", { kind: "chat", settings: collectSettings() });
$("pickAnalysisImage").onclick = () => post("pickAnalysisImage");
$("pickEditImages").onclick = () => post("pickEditImages", { existing: editImages.length });
$("analyzeBtn").onclick = () => post("analyze", { settings: collectSettings(), image: analysisImage });
$("sendEdit").onclick = () => post("edit", { settings: collectSettings(), images: editImages, prompt: $("editPrompt").value, size: $("size").value, quality: $("quality").value });
$("clearHistory").onclick = () => post("clearHistory");

for (const id of ["analysisDrop", "editDrop"]) {
  const el = $(id);
  el.ondragover = e => { e.preventDefault(); el.classList.add("over"); };
  el.ondragleave = () => el.classList.remove("over");
  el.ondrop = e => {
    e.preventDefault();
    el.classList.remove("over");
    const files = [...e.dataTransfer.files].map(f => f.path).filter(Boolean);
    post(id === "analysisDrop" ? "dropAnalysis" : "dropEdit", { files, existing: editImages.length });
  };
}

chrome.webview.addEventListener("message", (event) => {
  const { type, payload } = event.data;
  if (type === "init") {
    settings = payload.settings;
    $("imageBaseUrl").value = settings.ImageBaseUrl || "https://www.cctq.ai/v1";
    $("imageApiKey").value = settings.ImageApiKey || "";
    $("chatBaseUrl").value = settings.ChatBaseUrl || "https://www.cctq.ai/v1";
    $("chatApiKey").value = settings.ChatApiKey || "";
    setModels("imageModel", settings.ImageModels, settings.ImageModel);
    setModels("chatModel", settings.ChatModels, settings.ChatModel);
    renderHistory(payload.history);
  }
  if (type === "pingResult") {
    const target = payload.kind === "image" ? "imagePing" : "chatPing";
    $(target).textContent = payload.message;
    setModels(payload.kind === "image" ? "imageModel" : "chatModel", payload.models, payload.selected);
  }
  if (type === "analysisImage") { analysisImage = payload; renderFiles(); }
  if (type === "editImages") { editImages = payload; renderFiles(); }
  if (type === "analysisResult") {
    $("analysisMeta").textContent = payload.meta;
    $("issues").value = payload.issues;
    $("prompt").value = payload.prompt;
    $("negative").value = payload.negative;
    $("editPrompt").value = "";
    usingDefault = false;
    $("useDefault").textContent = "使用第 3 步默认提示词";
    renderHistory(payload.history);
  }
  if (type === "editResult") {
    const div = document.createElement("div");
    div.innerHTML = `<div class="bubble">${escape(payload.prompt)}</div><img class="resultImage" src="${payload.dataUrl}"><a class="saveLink" href="#" data-save="${escape(payload.path)}">已保存：${escape(payload.path)}</a>`;
    $("chatMessages").appendChild(div);
    renderHistory(payload.history);
  }
  if (type === "error") alert(payload.message);
  if (type === "history") renderHistory(payload.history);
});

post("ready");
