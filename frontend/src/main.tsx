import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CheckCircle2,
  Clock3,
  History,
  ImagePlus,
  Loader2,
  MessageSquareText,
  PlugZap,
  Save,
  Send,
  Settings2,
  Sparkles,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import "./styles.css";

declare global {
  interface Window {
    chrome?: {
      webview?: {
        postMessage: (message: unknown) => void;
        addEventListener: (event: "message", cb: (event: MessageEvent) => void) => void;
      };
    };
    appReceive?: (message: { type: string; payload: any }) => void;
  }
}

type FilePayload = { name: string; path?: string; mime: string; base64: string; dataUrl: string };
type HistoryItem = {
  CreatedAt: string;
  Action: string;
  Status: string;
  Model: string;
  FileName: string;
  Duration?: string;
  Prompt?: string;
  Error?: string;
};
type Settings = {
  ImageBaseUrl: string;
  ImageApiKey: string;
  ImageModel: string;
  ChatBaseUrl: string;
  ChatApiKey: string;
  ChatModel: string;
  ImageModels: string[];
  ChatModels: string[];
};

const defaultSettings: Settings = {
  ImageBaseUrl: "https://www.cctq.ai/v1",
  ImageApiKey: "",
  ImageModel: "",
  ChatBaseUrl: "https://www.cctq.ai/v1",
  ChatApiKey: "",
  ChatModel: "",
  ImageModels: [],
  ChatModels: [],
};

const post = (type: string, payload: Record<string, unknown> = {}) => {
  window.chrome?.webview?.postMessage({ type, payload });
};

const readFiles = async (files: File[], limit: number): Promise<FilePayload[]> => {
  const selected = files.slice(0, limit);
  return Promise.all(
    selected.map(
      (file) =>
        new Promise<FilePayload>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error);
          reader.onload = () => {
            const dataUrl = String(reader.result || "");
            resolve({
              name: file.name,
              mime: file.type || "application/octet-stream",
              base64: dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl,
              dataUrl,
            });
          };
          reader.readAsDataURL(file);
        }),
    ),
  );
};

function App() {
  const [view, setView] = useState<"analysis" | "edit" | "settings">("settings");
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [unlocked, setUnlocked] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState<"" | "analysis" | "edit">("");
  const [analysisImage, setAnalysisImage] = useState<FilePayload | null>(null);
  const [editImages, setEditImages] = useState<FilePayload[]>([]);
  const [issues, setIssues] = useState("");
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [usingDefault, setUsingDefault] = useState(false);
  const [messages, setMessages] = useState<Array<{ prompt: string; dataUrl: string; path: string }>>([]);
  const [status, setStatus] = useState({ image: "等待检测", chat: "等待检测", analysis: "", edit: "" });
  const [size, setSize] = useState("auto");
  const [quality, setQuality] = useState("auto");

  useEffect(() => {
    const handle = (message: { type: string; payload: any }) => {
      const { type, payload } = message || {};
      if (type === "init") {
        setSettings({ ...defaultSettings, ...(payload.settings || {}) });
        setHistory(payload.history || []);
      }
      if (type === "pingResult") {
        setChecking(false);
        setStatus((s) => ({ ...s, [payload.kind]: payload.message }));
        setSettings((s) => ({
          ...s,
          [payload.kind === "image" ? "ImageModels" : "ChatModels"]: payload.models || [],
          [payload.kind === "image" ? "ImageModel" : "ChatModel"]: payload.selected || "",
        }));
      }
      if (type === "unlockState") {
        setChecking(false);
        const ok = Boolean(payload.unlocked);
        setUnlocked(ok);
        if (ok) setView("analysis");
      }
      if (type === "analysisImage") setAnalysisImage(payload);
      if (type === "editImages") setEditImages((prev) => [...prev, ...(payload || [])].slice(0, 3));
      if (type === "analysisResult") {
        setBusy("");
        setStatus((s) => ({ ...s, analysis: payload.meta }));
        setIssues(payload.issues || "");
        setPrompt(payload.prompt || "");
        setNegative(payload.negative || "");
        setEditPrompt("");
        setUsingDefault(false);
        setHistory(payload.history || []);
      }
      if (type === "editResult") {
        setBusy("");
        setMessages((prev) => [...prev, { prompt: payload.prompt, dataUrl: payload.dataUrl, path: payload.path }]);
        setHistory(payload.history || []);
        setStatus((s) => ({ ...s, edit: `已保存到：${payload.path}` }));
      }
      if (type === "history") setHistory(payload.history || []);
      if (type === "error") {
        setBusy("");
        setChecking(false);
        setStatus((s) => ({ ...s, analysis: payload.message, edit: payload.message }));
        alert(payload.message);
      }
    };
    window.appReceive = handle;
    window.chrome?.webview?.addEventListener("message", (event) => handle(event.data));
    post("ready");
  }, []);

  const settingsPayload = {
    imageBaseUrl: settings.ImageBaseUrl,
    imageApiKey: settings.ImageApiKey,
    imageModel: settings.ImageModel,
    chatBaseUrl: settings.ChatBaseUrl,
    chatApiKey: settings.ChatApiKey,
    chatModel: settings.ChatModel,
  };
  const defaultPrompt = useMemo(
    () => [prompt.trim(), negative.trim() ? `负面提示词：${negative.trim()}` : ""].filter(Boolean).join("\n\n"),
    [prompt, negative],
  );

  const handleDrop = (kind: "analysis" | "edit") => async (event: React.DragEvent) => {
    event.preventDefault();
    const limit = kind === "analysis" ? 1 : 3 - editImages.length;
    const files = await readFiles(Array.from(event.dataTransfer.files), Math.max(0, limit));
    if (!files.length) return;
    if (kind === "analysis") setAnalysisImage(files[0]);
    else setEditImages((prev) => [...prev, ...files].slice(0, 3));
  };

  const ping = (kind: "image" | "chat") => {
    setStatus((s) => ({ ...s, [kind]: "正在检测连接..." }));
    post("ping", { kind, settings: settingsPayload });
  };

  const runAnalysis = () => {
    setBusy("analysis");
    setStatus((s) => ({ ...s, analysis: "正在分析图像并生成提示词..." }));
    post("analyze", { settings: settingsPayload, image: analysisImage });
  };

  const runEdit = () => {
    setBusy("edit");
    setStatus((s) => ({ ...s, edit: "正在调用绘图模型..." }));
    post("edit", { settings: settingsPayload, images: editImages, prompt: editPrompt, size, quality });
  };

  const toggleDefault = () => {
    if (usingDefault) {
      setEditPrompt("");
      setUsingDefault(false);
    } else if (defaultPrompt) {
      setEditPrompt(defaultPrompt);
      setUsingDefault(true);
    }
  };

  return (
    <div className="app-shell">
      {!unlocked && view !== "settings" ? null : (
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">IP</div>
            <div>
              <div className="brand-title">图像优化工作台</div>
              <div className="brand-subtitle">Image Prompt Operator</div>
            </div>
          </div>
          <nav className="nav-stack">
            <Nav active={view === "settings"} icon={<Settings2 size={17} />} onClick={() => setView("settings")}>
              模型服务
            </Nav>
            <Nav disabled={!unlocked} active={view === "analysis"} icon={<MessageSquareText size={17} />} onClick={() => setView("analysis")}>
              分析提示词
            </Nav>
            <Nav disabled={!unlocked} active={view === "edit"} icon={<Wand2 size={17} />} onClick={() => setView("edit")}>
              图像编辑
            </Nav>
          </nav>
          <div className="history-head">
            <span><History size={14} />历史记录</span>
            <button onClick={() => post("clearHistory")}>清空</button>
          </div>
          <div className="history-list">
            {history.length === 0 ? (
              <div className="empty-history">完成分析或生成后会显示在这里。</div>
            ) : (
              history.map((item, index) => <HistoryRow key={`${item.CreatedAt}-${index}`} item={item} />)
            )}
          </div>
        </aside>
      )}
      <main className={unlocked || view === "settings" ? "main" : "main full"}>
        <datalist id="image-models">{settings.ImageModels.map((m) => <option key={m} value={m} />)}</datalist>
        <datalist id="chat-models">{settings.ChatModels.map((m) => <option key={m} value={m} />)}</datalist>
        {view === "settings" && (
          <SettingsView
            settings={settings}
            setSettings={setSettings}
            status={status}
            unlocked={unlocked}
            checking={checking}
            onPing={ping}
          />
        )}
        {view === "analysis" && unlocked && (
          <AnalysisView
            settings={settings}
            setSettings={setSettings}
            image={analysisImage}
            issues={issues}
            prompt={prompt}
            negative={negative}
            status={status.analysis}
            busy={busy === "analysis"}
            onDrop={handleDrop("analysis")}
            onPick={() => post("pickAnalysisImage")}
            onRun={runAnalysis}
            onIssues={setIssues}
            onPrompt={setPrompt}
            onNegative={setNegative}
          />
        )}
        {view === "edit" && unlocked && (
          <EditView
            settings={settings}
            setSettings={setSettings}
            images={editImages}
            setImages={setEditImages}
            messages={messages}
            prompt={editPrompt}
            setPrompt={(v) => {
              setEditPrompt(v);
              if (usingDefault && v !== defaultPrompt) setUsingDefault(false);
            }}
            usingDefault={usingDefault}
            toggleDefault={toggleDefault}
            size={size}
            setSize={setSize}
            quality={quality}
            setQuality={setQuality}
            status={status.edit}
            busy={busy === "edit"}
            onDrop={handleDrop("edit")}
            onPick={() => post("pickEditImages", { existing: editImages.length })}
            onRun={runEdit}
          />
        )}
      </main>
    </div>
  );
}

function SettingsView({
  settings,
  setSettings,
  status,
  unlocked,
  checking,
  onPing,
}: {
  settings: Settings;
  setSettings: (s: Settings) => void;
  status: { image: string; chat: string };
  unlocked: boolean;
  checking: boolean;
  onPing: (kind: "image" | "chat") => void;
}) {
  return (
    <section className="gate">
      <div className="gate-panel">
        <div className="gate-orbit">
          {checking ? <Loader2 className="spin" size={24} /> : unlocked ? <CheckCircle2 size={25} /> : <PlugZap size={25} />}
        </div>
        <div className="gate-copy">
          <p className="eyebrow">Service gate</p>
          <h1>连接模型服务</h1>
          <p>进入工作台前先检测绘图服务和对话服务。已保存的 Key 会在启动时自动检测，通过后直接解锁。</p>
        </div>
        <div className="service-grid">
          <ServiceCard
            title="绘图服务"
            status={status.image}
            url={settings.ImageBaseUrl}
            apiKey={settings.ImageApiKey}
            onUrl={(v) => setSettings({ ...settings, ImageBaseUrl: v })}
            onKey={(v) => setSettings({ ...settings, ImageApiKey: v })}
            onPing={() => onPing("image")}
          />
          <ServiceCard
            title="对话服务"
            status={status.chat}
            url={settings.ChatBaseUrl}
            apiKey={settings.ChatApiKey}
            onUrl={(v) => setSettings({ ...settings, ChatBaseUrl: v })}
            onKey={(v) => setSettings({ ...settings, ChatApiKey: v })}
            onPing={() => onPing("chat")}
          />
        </div>
        <div className={unlocked ? "gate-status ok" : "gate-status"}>
          {unlocked ? "服务已联通，工作台已解锁。" : "两个服务都检测通过后，分析和图像编辑功能才会开放。"}
        </div>
      </div>
    </section>
  );
}

function ServiceCard(props: {
  title: string;
  status: string;
  url: string;
  apiKey: string;
  onUrl: (value: string) => void;
  onKey: (value: string) => void;
  onPing: () => void;
}) {
  return (
    <div className="service-card">
      <div className="service-title">
        <span>{props.title}</span>
        <small>{props.status}</small>
      </div>
      <Field label="URL">
        <input className="input" value={props.url} onChange={(e) => props.onUrl(e.target.value)} />
      </Field>
      <Field label="API Key">
        <input className="input" type="password" value={props.apiKey} onChange={(e) => props.onKey(e.target.value)} />
      </Field>
      <button className="btn-primary wide" onClick={props.onPing}>测试联通并读取模型</button>
    </div>
  );
}

function AnalysisView(props: {
  settings: Settings;
  setSettings: (settings: Settings) => void;
  image: FilePayload | null;
  issues: string;
  prompt: string;
  negative: string;
  status: string;
  busy: boolean;
  onDrop: (event: React.DragEvent) => void;
  onPick: () => void;
  onRun: () => void;
  onIssues: (value: string) => void;
  onPrompt: (value: string) => void;
  onNegative: (value: string) => void;
}) {
  return (
    <section className="workspace scrollable">
      <Header title="分析提示词" subtitle="选择用于分析的原图，由对话模型识别问题并生成可用于绘图编辑的提示词。" />
      <div className="two-column">
        <div className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Input</p>
              <h2>分析图像</h2>
            </div>
            <button className="btn" onClick={props.onPick}><Upload size={16} />选择图像</button>
          </div>
          <DropZone onDrop={props.onDrop}>
            {props.image ? <img src={props.image.dataUrl} className="preview-large" /> : <EmptyUpload text="拖拽 JPG、PNG 或 RAW 图像到这里" />}
          </DropZone>
          <Field label="对话模型">
            <ModelSelect value={props.settings.ChatModel} models={props.settings.ChatModels} list="chat-models" onChange={(v) => props.setSettings({ ...props.settings, ChatModel: v })} />
          </Field>
          <button className="btn-primary wide" onClick={props.onRun} disabled={props.busy}>
            {props.busy ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}分析图像并生成提示词
          </button>
          <div className="meta">{props.status}</div>
        </div>
        <div className="panel result-panel">
          <TextArea label="图像不足与优化思路" value={props.issues} onChange={props.onIssues} readOnly />
          <TextArea label="给绘图模型的编辑提示词" value={props.prompt} onChange={props.onPrompt} />
          <TextArea label="负面提示词" value={props.negative} onChange={props.onNegative} small />
        </div>
      </div>
    </section>
  );
}

function EditView(props: {
  settings: Settings;
  setSettings: (settings: Settings) => void;
  images: FilePayload[];
  setImages: (images: FilePayload[]) => void;
  messages: Array<{ prompt: string; dataUrl: string; path: string }>;
  prompt: string;
  setPrompt: (value: string) => void;
  usingDefault: boolean;
  toggleDefault: () => void;
  size: string;
  setSize: (value: string) => void;
  quality: string;
  setQuality: (value: string) => void;
  status: string;
  busy: boolean;
  onDrop: (event: React.DragEvent) => void;
  onPick: () => void;
  onRun: () => void;
}) {
  return (
    <section className="chat-workspace">
      <Header title="图像编辑" subtitle="像对话一样提交编辑任务。每次请求最多带三张图，并单独选择绘图模型、尺寸和质量。" />
      <div className="chat-feed">
        {props.messages.length === 0 ? (
          <div className="empty-chat">
            <Wand2 size={24} />
            <h2>等待第一张优化图像</h2>
            <p>把需要编辑的图像拖进下方输入框，写下绘图提示词，然后生成。</p>
          </div>
        ) : (
          props.messages.map((m, i) => (
            <div className="message-pair" key={`${m.path}-${i}`}>
              <div className="user-bubble">{m.prompt}</div>
              <div className="image-answer">
                <img src={m.dataUrl} />
                <div><Save size={13} />{m.path}</div>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={props.onDrop}>
        <div className="chips-row">
          {props.images.map((img, i) => (
            <div className="thumb-chip" key={`${img.name}-${i}`}>
              <img src={img.dataUrl} />
              <button onClick={() => props.setImages(props.images.filter((_, index) => index !== i))}><X size={12} /></button>
            </div>
          ))}
          {props.images.length === 0 && <span className="drop-hint"><ImagePlus size={15} />拖拽或添加最多三张图像</span>}
        </div>
        <textarea
          className="composer-input"
          value={props.prompt}
          onChange={(e) => props.setPrompt(e.target.value)}
          placeholder="描述你想怎样编辑图像..."
        />
        <div className="composer-toolbar">
          <button className="btn" onClick={props.onPick} disabled={props.images.length >= 3}><ImagePlus size={16} />添加图像</button>
          <button className={props.usingDefault ? "btn active" : "btn"} onClick={props.toggleDefault}>使用第 3 步默认提示词</button>
          <ModelSelect compact value={props.settings.ImageModel} models={props.settings.ImageModels} list="image-models" onChange={(v) => props.setSettings({ ...props.settings, ImageModel: v })} />
          <select className="select compact" value={props.size} onChange={(e) => props.setSize(e.target.value)}>
            <option>auto</option>
            <option>1024x1024</option>
            <option>1536x1024</option>
            <option>1024x1536</option>
          </select>
          <select className="select compact" value={props.quality} onChange={(e) => props.setQuality(e.target.value)}>
            <option>auto</option>
            <option>high</option>
            <option>medium</option>
            <option>low</option>
          </select>
          <button className="send-button" onClick={props.onRun} disabled={props.busy}>
            {props.busy ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
          </button>
        </div>
        <div className="meta">{props.status}</div>
      </div>
    </section>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">Workbench</p>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className="time-pill"><Clock3 size={14} />{new Date().toLocaleDateString()}</div>
    </header>
  );
}

function Nav({ active, disabled, icon, children, onClick }: { active: boolean; disabled?: boolean; icon: React.ReactNode; children: React.ReactNode; onClick: () => void }) {
  return (
    <button disabled={disabled} onClick={onClick} className={active ? "nav-item active" : disabled ? "nav-item disabled" : "nav-item"}>
      {icon}
      {children}
    </button>
  );
}

function HistoryRow({ item }: { item: HistoryItem }) {
  return (
    <div className="history-row">
      <div className="history-action">{item.Action}</div>
      <div className="history-meta">{item.Status} · {item.Model || "未记录模型"}</div>
      <div className="history-date">{item.CreatedAt}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function ModelSelect({ value, models, onChange, compact, list }: { value: string; models: string[]; onChange: (v: string) => void; compact?: boolean; list: string }) {
  return <input className={compact ? "input compact" : "input"} list={list} value={value || ""} onChange={(e) => onChange(e.target.value)} placeholder={models.length ? "选择或输入模型" : "可手动输入模型"} />;
}

function TextArea({ label, value, onChange, readOnly, small }: { label: string; value: string; onChange: (v: string) => void; readOnly?: boolean; small?: boolean }) {
  return (
    <Field label={label}>
      <textarea readOnly={readOnly} className={small ? "textarea small" : "textarea"} value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function DropZone({ children, onDrop }: { children: React.ReactNode; onDrop: (event: React.DragEvent) => void }) {
  return <div className="dropzone" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>{children}</div>;
}

function EmptyUpload({ text }: { text: string }) {
  return (
    <div className="empty-upload">
      <Upload size={22} />
      <span>{text}</span>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
