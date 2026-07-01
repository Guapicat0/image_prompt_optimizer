import React, { useEffect, useRef, useState } from "react";
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

type FilePayload = { name: string; path?: string; mime: string; base64: string; dataUrl: string; localUrl?: string };
type EditTurn = { prompt: string; dataUrl: string; path: string; model: string; createdAt: string; sourceImages: FilePayload[]; localUrl?: string };
type EditSession = {
  id: string;
  CreatedAt: string;
  UpdatedAt: string;
  Action: string;
  Status: string;
  Model: string;
  FileName: string;
  Duration?: string;
  Prompt?: string;
  Error?: string;
  Turns: EditTurn[];
};
type HistoryItem = {
  CreatedAt: string;
  Action: string;
  Status: string;
  Model: string;
  FileName: string;
  Duration?: string;
  Prompt?: string;
  Error?: string;
  Issues?: string;
  NegativePrompt?: string;
  Rationale?: string;
  OutputPath?: string;
  OutputDataUrl?: string;
  InputImages?: Array<{ name?: string; path?: string; mime?: string; dataUrl?: string }>;
  Turns?: EditTurn[];
  UpdatedAt?: string;
};
type HistoryEntry = HistoryItem | EditSession;
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

const EDIT_SESSIONS_KEY = "image-prompt-optimizer-edit-sessions";

const localImageUrl = (path: unknown) => {
  const value = String(path || "");
  return value ? `https://app.local/__local_image__?path=${encodeURIComponent(value)}` : "";
};
const stripStoredImage = <T extends Partial<FilePayload> | Partial<EditTurn>>(image: T): T => {
  const path = String(image?.path || "");
  return {
    ...image,
    base64: "",
    dataUrl: "",
    localUrl: image?.localUrl || localImageUrl(path),
  };
};
const stripStoredTurn = (turn: EditTurn): EditTurn => ({
  ...stripStoredImage(turn),
  sourceImages: (turn.sourceImages || []).map((image) => stripStoredImage(image) as FilePayload),
});
const stripStoredSession = (session: EditSession): EditSession => ({
  ...session,
  Turns: (session.Turns || []).map(stripStoredTurn),
});
const stripStoredSessions = (sessions: EditSession[]) => sessions.map(stripStoredSession);
const attachLocalUrlsToTurn = (turn: EditTurn): EditTurn => ({
  ...turn,
  localUrl: turn.localUrl || localImageUrl(turn.path),
  sourceImages: (turn.sourceImages || []).map((image) => ({
    ...image,
    localUrl: image.localUrl || localImageUrl(image.path),
  })),
});

const loadEditSessions = (): EditSession[] => [];

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

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const isEditSession = (item: HistoryEntry): item is EditSession => Array.isArray((item as EditSession).Turns);
const latestEntries = (items: HistoryEntry[]) =>
  [...items].sort((a, b) => new Date((b as EditSession).UpdatedAt || b.CreatedAt).getTime() - new Date((a as EditSession).UpdatedAt || a.CreatedAt).getTime());
const imageSrc = (image: Partial<FilePayload> | Partial<EditTurn> | null | undefined) => image?.dataUrl || "";
const fileNameFromPath = (path: unknown, fallback = "edited.png") => {
  const value = String(path || fallback);
  return value.split(/[\\/]/).pop() || fallback;
};
const imagePayloadFromTurn = (turn: Partial<EditTurn>): FilePayload => {
  const dataUrl = turn.dataUrl || "";
  return {
    name: fileNameFromPath(turn.path),
    path: turn.path || "",
    mime: "image/png",
    base64: dataUrl.includes(",") ? dataUrl.split(",")[1] : "",
    dataUrl,
    localUrl: turn.localUrl || localImageUrl(turn.path),
  };
};
const sessionNeedsHydration = (session: EditSession) =>
  session.Turns.some((turn) => (turn.path && !turn.dataUrl) || turn.sourceImages?.some((img) => img?.path && !img.dataUrl));
const isEditHistoryItem = (item: HistoryItem) =>
  item.Action.includes("图像编辑") || item.Action.includes("绘图模型编辑") || item.Action === "调用绘图模型编辑";
const sessionFromHistoryItem = (item: HistoryItem): EditSession | null => {
  if (!isEditHistoryItem(item)) return null;
  const outputPath = item.OutputPath || "";
  const inputImages = (item.InputImages || []).map((image) => ({
    name: image.name || fileNameFromPath(image.path, "image.png"),
    path: image.path || "",
    mime: image.mime || "image/png",
    base64: "",
    dataUrl: image.dataUrl || "",
    localUrl: localImageUrl(image.path),
  }) as FilePayload);
  const turn = stripStoredImage({
    prompt: item.Prompt || "",
    dataUrl: "",
    path: outputPath,
    model: item.Model || "",
    createdAt: item.CreatedAt,
    sourceImages: inputImages,
  }) as EditTurn;
  return {
    id: `history-${item.CreatedAt}-${outputPath}`,
    CreatedAt: item.CreatedAt,
    UpdatedAt: item.UpdatedAt || item.CreatedAt,
    Action: "图像编辑对话",
    Status: item.Status,
    Model: item.Model,
    FileName: item.FileName || fileNameFromPath(outputPath),
    Duration: item.Duration || "1 轮",
    Prompt: item.Prompt || "",
    Error: item.Error || "",
    Turns: [turn],
  };
};
const sessionsFromHistory = (items: HistoryItem[]) => {
  const sessions = items.map(sessionFromHistoryItem).filter((session): session is EditSession => Boolean(session));
  const byOutput = new Map<string, EditSession>();
  for (const session of sessions) {
    const outputPath = session.Turns[0]?.path;
    if (outputPath) byOutput.set(outputPath, session);
  }

  const rootFor = (session: EditSession) => {
    let current = session;
    const seen = new Set<string>();
    while (!seen.has(current.id)) {
      seen.add(current.id);
      const inputPath = current.Turns[0]?.sourceImages?.map((image) => image.path).find(Boolean);
      const parent = inputPath ? byOutput.get(inputPath) : null;
      if (!parent || parent.id === current.id) break;
      current = parent;
    }
    return current;
  };

  const grouped = new Map<string, EditSession>();
  for (const session of sessions) {
    const root = rootFor(session);
    const existing = grouped.get(root.id);
    if (existing) {
      existing.Turns = [...existing.Turns, ...session.Turns].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      existing.UpdatedAt = new Date(session.UpdatedAt).getTime() > new Date(existing.UpdatedAt).getTime() ? session.UpdatedAt : existing.UpdatedAt;
      existing.Prompt = existing.Turns[existing.Turns.length - 1]?.prompt || existing.Prompt;
      existing.Duration = `${existing.Turns.length} 轮`;
    } else {
      grouped.set(root.id, { ...root, Turns: [...session.Turns] });
    }
  }

  return Array.from(grouped.values()).map((session) => ({
    ...session,
    Turns: session.Turns.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    Duration: `${session.Turns.length} 轮`,
    Prompt: session.Turns[session.Turns.length - 1]?.prompt || session.Prompt,
  }));
};
const upsertEditSession = (sessions: EditSession[], id: string, turn: EditTurn, model: string): EditSession[] => {
  const existing = sessions.find((session) => session.id === id);
  const turns = existing ? [...existing.Turns, turn] : [turn];
  const firstImage = turns[0]?.sourceImages?.[0];
  const next: EditSession = {
    id,
    CreatedAt: existing?.CreatedAt || turn.createdAt,
    UpdatedAt: turn.createdAt,
    Action: "图像编辑对话",
    Status: turns.some((t) => t.path) ? "成功" : "进行中",
    Model: model || existing?.Model || turn.model,
    FileName: firstImage?.name || existing?.FileName || "未记录",
    Duration: turns.length === 1 ? "1 轮" : `${turns.length} 轮`,
    Prompt: turns[turns.length - 1]?.prompt || "",
    Error: "",
    Turns: turns,
  };
  return [next, ...sessions.filter((session) => session.id !== id)];
};

function App() {
  const [view, setView] = useState<"analysis" | "analysisHistory" | "edit" | "settings">("settings");
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [editSessions, setEditSessions] = useState<EditSession[]>(loadEditSessions);
  const [currentSessionId, setCurrentSessionId] = useState(() => makeId());
  const [selectedHistory, setSelectedHistory] = useState<HistoryEntry | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState<"" | "analysis" | "edit">("");
  const [analysisImage, setAnalysisImage] = useState<FilePayload | null>(null);
  const [editImages, setEditImages] = useState<FilePayload[]>([]);
  const [issues, setIssues] = useState("");
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [messages, setMessages] = useState<EditTurn[]>([]);
  const [status, setStatus] = useState({ image: "等待检测", chat: "等待检测", analysis: "", edit: "" });
  const [size, setSize] = useState("auto");
  const [quality, setQuality] = useState("auto");
  const latestRef = useRef({ settings, editImages, currentSessionId });
  const visibleHistory = latestEntries([...sessionsFromHistory(history), ...history.filter((item) => !isEditHistoryItem(item))]);

  useEffect(() => {
    latestRef.current = { settings, editImages, currentSessionId };
  }, [settings, editImages, currentSessionId]);

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
        setHistory(payload.history || []);
      }
      if (type === "editResult") {
        setBusy("");
        const turn: EditTurn = {
          prompt: payload.prompt,
          dataUrl: payload.dataUrl,
          path: payload.path,
          model: settings.ImageModel,
          createdAt: new Date().toLocaleString(),
          sourceImages: latestRef.current.editImages,
          localUrl: localImageUrl(payload.path),
        };
        setMessages((prev) => [...prev, turn]);
        setEditImages([imagePayloadFromTurn(turn)]);
        setEditPrompt("");
        setHistory(payload.history || []);
        setStatus((s) => ({ ...s, edit: `已保存到：${payload.path}` }));
      }
      if (type === "editSessionHydrated") {
        const turns = (Array.isArray(payload.turns) ? payload.turns : []).map(attachLocalUrlsToTurn);
        setMessages(turns);
        const last = turns[turns.length - 1];
        setEditImages(last ? [imagePayloadFromTurn(last)] : []);
        setStatus((s) => ({ ...s, edit: turns.some((turn: EditTurn) => !imageSrc(turn)) ? "部分历史图片文件已不存在，无法恢复。" : "已恢复历史图片，可以继续编辑。" }));
      }
      if (type === "history") {
        setHistory(payload.history || []);
        setSelectedHistory(null);
      }
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

  const startNewEditSession = () => {
    setCurrentSessionId(makeId());
    setMessages([]);
    setEditImages([]);
    setEditPrompt("");
    setStatus((s) => ({ ...s, edit: "已开启新一轮对话。" }));
    setView("edit");
  };

  const resumeEditSession = (session: EditSession) => {
    const turns = Array.isArray(session.Turns) ? session.Turns : [];
    const storedTurns = stripStoredSessions([{ ...session, Turns: turns }])[0].Turns;
    const last = storedTurns[storedTurns.length - 1];
    setCurrentSessionId(session.id);
    setMessages(storedTurns);
    setEditImages(last ? [imagePayloadFromTurn(last)] : (storedTurns[0]?.sourceImages || []));
    setEditPrompt("");
    setSelectedHistory(null);
    setStatus((s) => ({ ...s, edit: sessionNeedsHydration(session) ? "正在从本地文件恢复历史图片..." : "已回到图像编辑对话，可以继续编辑。" }));
    setView("edit");
    if (sessionNeedsHydration(session)) post("hydrateEditSession", { sessionId: session.id, turns });
  };

  const openHistory = (item: HistoryEntry) => {
    if (isEditSession(item)) {
      resumeEditSession(item);
      return;
    }
    setSelectedHistory(item);
    setView("analysisHistory");
  };

  return (
    <div className="app-shell">
      {unlocked && (
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">IP</div>
            <div>
              <div className="brand-title">图像优化工作台</div>
              <div className="brand-subtitle">Image Prompt Operator</div>
            </div>
          </div>
          <nav className="nav-stack">
            <Nav disabled={!unlocked} active={view === "analysis"} icon={<Sparkles size={17} />} onClick={() => setView("analysis")}>
              图像分析
            </Nav>
            <Nav disabled={!unlocked} active={view === "edit"} icon={<Wand2 size={17} />} onClick={() => setView("edit")}>
              图像编辑
            </Nav>
            <button className="new-edit-button" disabled={!unlocked} onClick={startNewEditSession}>
              <ImagePlus size={17} />新图像编辑
            </button>
          </nav>
          <div className="history-head">
            <span><History size={14} />最近</span>
            <button onClick={() => post("clearHistory")}>清空</button>
          </div>
          <div className="history-list">
            {visibleHistory.length === 0 ? (
              <div className="empty-history">最近的分析和图像编辑对话会显示在这里。</div>
            ) : (
              visibleHistory.map((item, index) => <HistoryRow key={`${item.CreatedAt}-${index}`} item={item} active={(isEditSession(item) && item.id === currentSessionId && view === "edit") || (!isEditSession(item) && selectedHistory === item && view === "analysisHistory")} onClick={() => openHistory(item)} />)
            )}
          </div>
        </aside>
      )}
      <main className={unlocked ? "main" : "main full"}>
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
        {view === "analysisHistory" && unlocked && selectedHistory && !isEditSession(selectedHistory) && (
          <AnalysisHistoryView item={selectedHistory} />
        )}
        {view === "edit" && unlocked && (
          <EditView
            settings={settings}
            setSettings={setSettings}
            images={editImages}
            setImages={setEditImages}
            messages={messages}
            prompt={editPrompt}
            setPrompt={setEditPrompt}
            size={size}
            setSize={setSize}
            quality={quality}
            setQuality={setQuality}
            status={status.edit}
            busy={busy === "edit"}
            onDrop={handleDrop("edit")}
            onPick={() => post("pickEditImages", { existing: editImages.length })}
            onRun={runEdit}
            onNewSession={startNewEditSession}
            onUseImage={(image) => {
              setEditImages([image]);
              setStatus((s) => ({ ...s, edit: "已把这张图放入下一轮编辑。" }));
            }}
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
      <Header title="图像分析" subtitle="选择用于分析的原图，由对话模型识别问题并生成可用于绘图编辑的提示词。" />
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
  messages: EditTurn[];
  prompt: string;
  setPrompt: (value: string) => void;
  size: string;
  setSize: (value: string) => void;
  quality: string;
  setQuality: (value: string) => void;
  status: string;
  busy: boolean;
  onDrop: (event: React.DragEvent) => void;
  onPick: () => void;
  onRun: () => void;
  onNewSession: () => void;
  onUseImage: (image: FilePayload) => void;
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
              {m.sourceImages?.some((img) => imageSrc(img)) && (
                <div className="bubble-images user-images">
                  {m.sourceImages.map((img, index) => imageSrc(img) ? <img key={`${img.name}-${index}`} src={imageSrc(img)} /> : null)}
                </div>
              )}
              <div className="user-bubble">{m.prompt}</div>
              {imageSrc(m) && (
                <div className="image-answer">
                  <img src={imageSrc(m)} />
                  <button className="image-edit-button" onClick={() => props.onUseImage(imagePayloadFromTurn(m))}>编辑</button>
                  <a className="image-save-button" href={imageSrc(m)} download={fileNameFromPath(m.path)}>
                    <Save size={15} />
                  </a>
                  <div className="image-path"><Save size={13} />{m.path}</div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
      <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={props.onDrop}>
        <div className="chips-row">
          {props.images.map((img, i) => (
            <div className="thumb-chip" key={`${img.name}-${i}`}>
              {imageSrc(img) && <img src={imageSrc(img)} />}
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
          <button className="btn" onClick={props.onNewSession}>新对话</button>
          <button className="btn" onClick={props.onPick} disabled={props.images.length >= 3}><ImagePlus size={16} />添加图像</button>
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

function HistoryRow({ item, active, onClick }: { item: HistoryEntry; active?: boolean; onClick: () => void }) {
  const edit = isEditSession(item);
  return (
    <button className={active ? "history-row active" : "history-row"} onClick={onClick}>
      <div className="history-row-main">
        <span className={edit ? "history-kind edit" : "history-kind analysis"}>{edit ? <Wand2 size={13} /> : <Sparkles size={13} />}</span>
        <div className="history-text">
          <div className="history-action">{edit ? (item.Prompt || `图像编辑 · ${item.Turns.length} 轮`) : (item.Prompt || item.Action)}</div>
          <div className="history-meta">{edit ? `图像编辑 · ${item.Turns.length} 轮 · ${item.Model || "未记录模型"}` : `图像分析 · ${item.Status} · ${item.Model || "未记录模型"}`}</div>
        </div>
      </div>
      <div className="history-date">{item.CreatedAt}</div>
    </button>
  );
}

function AnalysisHistoryView({ item }: { item: HistoryItem }) {
  const issueText = [item.Issues, item.Rationale ? `优化思路：${item.Rationale}` : ""].filter(Boolean).join("\n\n");
  return (
    <section className="workspace scrollable">
      <Header title="图像分析" subtitle="这是最近记录里的只读分析结果，可查看原图、图像不足和生成给绘图模型的提示词。" />
      <div className="two-column">
        <div className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Input</p>
              <h2>分析图像</h2>
            </div>
            <span className="readonly-pill">历史记录</span>
          </div>
          <div className="dropzone history-dropzone">
            {item.InputImages?.[0]?.dataUrl ? <img src={item.InputImages[0].dataUrl} className="preview-large" /> : <EmptyUpload text="此记录没有保存原图预览" />}
          </div>
          <div className="history-detail-grid compact">
            <Info label="状态" value={item.Status} />
            <Info label="模型" value={item.Model || "未记录"} />
            <Info label="文件" value={item.FileName || "未记录"} />
            <Info label="耗时" value={item.Duration || "未记录"} />
            <Info label="时间" value={item.CreatedAt} wide />
          </div>
          <div className="meta">图像分析历史为只读记录，不会进入图像编辑会话。</div>
        </div>
        <div className="panel result-panel">
          {item.Error ? (
            <TextArea label="错误详情" value={item.Error} onChange={() => {}} readOnly />
          ) : (
            <>
              <TextArea label="图像不足与优化思路" value={issueText || "未记录"} onChange={() => {}} readOnly />
              <TextArea label="给绘图模型的编辑提示词" value={item.Prompt || "未记录"} onChange={() => {}} readOnly />
              <TextArea label="负面提示词" value={item.NegativePrompt || "未记录"} onChange={() => {}} readOnly small />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function HistoryDetail({ item, onClose, onUsePrompt }: { item: HistoryEntry; onClose: () => void; onUsePrompt: (value: string) => void }) {
  const session = isEditSession(item) ? item : null;
  const record = item as HistoryItem;
  const isEdit = item.Action.includes("绘图") || item.Action.includes("编辑");
  const issueText = session ? "" : [record.Issues, record.Rationale ? `优化思路：${record.Rationale}` : ""].filter(Boolean).join("\n\n");
  return (
    <div className="history-overlay" onClick={onClose}>
      <section className="history-detail" onClick={(event) => event.stopPropagation()}>
        <div className="history-detail-head">
          <div>
            <p className="eyebrow">History</p>
            <h2>{item.Action}</h2>
          </div>
          <button className="icon-button" onClick={onClose}><X size={17} /></button>
        </div>
        <div className="history-detail-grid">
          <Info label="状态" value={item.Status} />
          <Info label="模型" value={item.Model || "未记录"} />
          <Info label="文件" value={item.FileName || "未记录"} />
          <Info label="耗时" value={item.Duration || "未记录"} />
          <Info label="时间" value={item.CreatedAt} wide />
        </div>
        {item.Error && <DetailBlock title="错误详情" value={item.Error} tone="error" />}
        {session && <SessionImages session={session} />}
        {!session && record.InputImages && record.InputImages.length > 0 && (
          <div className="session-originals"><h3>原始图</h3><div className="history-image-grid">{record.InputImages.map((img, index) => img.dataUrl ? <ImageBlock key={`${img.name}-${index}`} title={img.name || `图片 ${index + 1}`} src={img.dataUrl} caption={img.path} /> : null)}</div></div>
        )}
        {issueText && <DetailBlock title="分析结果" value={issueText} />}
        {item.Prompt && <DetailBlock title={isEdit ? "图像编辑提示词" : "生成的提示词"} value={item.Prompt} />}
        {record.NegativePrompt && <DetailBlock title="负面提示词" value={record.NegativePrompt} />}
        {record.OutputDataUrl && <ImageBlock title="生成图片" src={record.OutputDataUrl || ""} caption={record.OutputPath || ""} />}
        {record.OutputPath && <DetailBlock title="生成图片保存位置" value={record.OutputPath || ""} />}
        {item.Prompt && (
          <div className="history-actions">
            <button className="btn-primary" onClick={() => onUsePrompt(item.Prompt || "")}>用这个提示词继续编辑</button>
          </div>
        )}
      </section>
    </div>
  );
}


function ImageBlock({ title, src, caption }: { title: string; src: string; caption?: string }) {
  return (
    <div className="detail-image-block">
      <h3>{title}</h3>
      <img src={src} />
      {caption && <div>{caption}</div>}
    </div>
  );
}

function SessionImages({ session }: { session: EditSession }) {
  const originals = session.Turns[0]?.sourceImages || [];
  return (
    <div className="session-history">
      {originals.length > 0 && (
        <div className="session-originals">
          <h3>原始图</h3>
          <div className="history-image-grid">
            {originals.map((img, index) => imageSrc(img) ? <ImageBlock key={`${img.name}-${index}`} title={img.name} src={imageSrc(img)} caption={img.path} /> : null)}
          </div>
        </div>
      )}
      {session.Turns.map((turn, index) => (
        <div className="session-turn" key={`${turn.path}-${index}`}>
          <div className="turn-prompt">第 {index + 1} 轮：{turn.prompt}</div>
          {imageSrc(turn) ? <ImageBlock title="生成图" src={imageSrc(turn)} caption={turn.path} /> : <DetailBlock title="生成图" value="图片文件不存在或尚未恢复。" />}
        </div>
      ))}
    </div>
  );
}
function Info({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return <div className={wide ? "info wide" : "info"}><span>{label}</span><strong>{value}</strong></div>;
}

function DetailBlock({ title, value, tone }: { title: string; value: string; tone?: "error" }) {
  return <div className={tone === "error" ? "detail-block error" : "detail-block"}><h3>{title}</h3><pre>{value}</pre></div>;
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
