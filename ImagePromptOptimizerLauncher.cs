using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class ImagePromptOptimizerProgram
{
    [STAThread]
    public static void Main()
    {
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)768 | SecurityProtocolType.Tls;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm());
    }
}

public sealed class MainForm : Form
{
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue, RecursionLimit = 100 };
    private readonly AppSettings settings = AppSettings.Load();
    private readonly HistoryStore history = new HistoryStore();
    private WebView2 web;
    private bool imageConnected = false;
    private bool chatConnected = false;

    public MainForm()
    {
        Text = "图像优化工作台";
        Width = 1280;
        Height = 860;
        MinimumSize = new Size(1100, 760);
        Initialize();
    }

    private async void Initialize()
    {
        web = new WebView2 { Dock = DockStyle.Fill, AllowExternalDrop = true };
        Controls.Add(web);
        await web.EnsureCoreWebView2Async();
        web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
        web.CoreWebView2.Settings.AreDevToolsEnabled = true;
        web.CoreWebView2.WebMessageReceived += OnMessage;
        web.CoreWebView2.AddWebResourceRequestedFilter("https://app.local/__local_image__*", CoreWebView2WebResourceContext.Image);
        web.CoreWebView2.WebResourceRequested += OnLocalImageRequested;
        web.CoreWebView2.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs args)
        {
            if (!args.IsSuccess)
            {
                MessageBox.Show("前端页面加载失败：" + args.WebErrorStatus, "图像优化工作台");
            }
        };
        string dist = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "webview-dist");
        web.CoreWebView2.SetVirtualHostNameToFolderMapping("app.local", dist, CoreWebView2HostResourceAccessKind.Allow);
        web.CoreWebView2.Navigate("https://app.local/index.html");
    }

    private void OnLocalImageRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        try
        {
            string query = new Uri(e.Request.Uri).Query.TrimStart('?');
            string path = "";
            foreach (string part in query.Split('&'))
            {
                string[] pieces = part.Split(new char[] { '=' }, 2);
                if (pieces.Length == 2 && pieces[0] == "path") path = Uri.UnescapeDataString(pieces[1]);
            }
            if (!File.Exists(path)) throw new FileNotFoundException(path);
            e.Response = web.CoreWebView2.Environment.CreateWebResourceResponse(File.OpenRead(path), 200, "OK", "Content-Type: " + InferMime(path));
        }
        catch
        {
            e.Response = web.CoreWebView2.Environment.CreateWebResourceResponse(new MemoryStream(new byte[0]), 404, "Not Found", "Content-Type: text/plain");
        }
    }

    private async void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var msg = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
            string type = S(msg, "type");
            var payload = msg.ContainsKey("payload") ? msg["payload"] as Dictionary<string, object> : new Dictionary<string, object>();
            if (type == "ready")
            {
                await Send("init", new { settings = settings, history = history.LoadLatest(200) });
                await AutoUnlock();
            }
            else if (type == "ping") await Ping(payload);
            else if (type == "pickAnalysisImage") await PickAnalysisImage();
            else if (type == "pickEditImages") await PickEditImages(Convert.ToInt32(payload["existing"]));
            else if (type == "dropAnalysis") await DropAnalysis(payload);
            else if (type == "dropEdit") await DropEdit(payload);
            else if (type == "analyze") await Analyze(payload);
            else if (type == "edit") await Edit(payload);
            else if (type == "hydrateEditSession") await HydrateEditSession(payload);
            else if (type == "clearHistory") { history.Clear(); await Send("history", new { history = history.LoadLatest(200) }); }
        }
        catch (Exception ex)
        {
            Task ignored = Send("error", new { message = Friendly(ex) });
        }
    }

    private async Task Ping(Dictionary<string, object> payload)
    {
        string kind = S(payload, "kind");
        var s = ToSettings(payload["settings"] as Dictionary<string, object>);
        Stopwatch sw = Stopwatch.StartNew();
        var data = await ApiClient.InvokeJson("GET", kind == "image" ? s.ImageBaseUrl : s.ChatBaseUrl, kind == "image" ? s.ImageApiKey : s.ChatApiKey, "/v1/models", null, 20);
        sw.Stop();
        List<string> models = FilterModels(ExtractModels(data), kind == "image");
        if (kind == "image") { imageConnected = true; settings.ImageBaseUrl = s.ImageBaseUrl; settings.ImageApiKey = s.ImageApiKey; settings.ImageModels = models; settings.ImageModel = Prefer(models, s.ImageModel, "gpt-image-2", "gpt-image-1"); }
        else { chatConnected = true; settings.ChatBaseUrl = s.ChatBaseUrl; settings.ChatApiKey = s.ChatApiKey; settings.ChatModels = models; settings.ChatModel = Prefer(models, s.ChatModel, "gpt-5.5", "gpt-4o", "gpt-4.1"); }
        settings.Save();
        await Send("pingResult", new { kind = kind, message = "联通，ping " + sw.ElapsedMilliseconds + " ms，发现 " + models.Count + " 个模型", models = models, selected = kind == "image" ? settings.ImageModel : settings.ChatModel });
        await Send("unlockState", new { unlocked = IsUnlocked() });
    }

    private async Task AutoUnlock()
    {
        bool hasImage = !String.IsNullOrWhiteSpace(settings.ImageBaseUrl) && !String.IsNullOrWhiteSpace(settings.ImageApiKey);
        bool hasChat = !String.IsNullOrWhiteSpace(settings.ChatBaseUrl) && !String.IsNullOrWhiteSpace(settings.ChatApiKey);
        if (!hasImage || !hasChat)
        {
            await Send("unlockState", new { unlocked = false });
            return;
        }
        string imagePingError = "";
        try
        {
            Stopwatch si = Stopwatch.StartNew();
            var imageData = await ApiClient.InvokeJson("GET", settings.ImageBaseUrl, settings.ImageApiKey, "/v1/models", null, 12);
            si.Stop();
            settings.ImageModels = FilterModels(ExtractModels(imageData), true);
            settings.ImageModel = Prefer(settings.ImageModels, settings.ImageModel, "gpt-image-2", "gpt-image-1");
            imageConnected = true;
            await Send("pingResult", new { kind = "image", message = "联通，ping " + si.ElapsedMilliseconds + " ms，发现 " + settings.ImageModels.Count + " 个模型", models = settings.ImageModels, selected = settings.ImageModel });
        }
        catch (Exception ex)
        {
            imageConnected = false;
            imagePingError = Friendly(ex);
        }
        if (!String.IsNullOrEmpty(imagePingError))
        {
            await Send("pingResult", new { kind = "image", message = "检测失败：" + imagePingError, models = settings.ImageModels, selected = settings.ImageModel });
        }
        string chatPingError = "";
        try
        {
            Stopwatch sc = Stopwatch.StartNew();
            var chatData = await ApiClient.InvokeJson("GET", settings.ChatBaseUrl, settings.ChatApiKey, "/v1/models", null, 12);
            sc.Stop();
            settings.ChatModels = FilterModels(ExtractModels(chatData), false);
            settings.ChatModel = Prefer(settings.ChatModels, settings.ChatModel, "gpt-5.5", "gpt-4o", "gpt-4.1");
            chatConnected = true;
            await Send("pingResult", new { kind = "chat", message = "联通，ping " + sc.ElapsedMilliseconds + " ms，发现 " + settings.ChatModels.Count + " 个模型", models = settings.ChatModels, selected = settings.ChatModel });
        }
        catch (Exception ex)
        {
            chatConnected = false;
            chatPingError = Friendly(ex);
        }
        if (!String.IsNullOrEmpty(chatPingError))
        {
            await Send("pingResult", new { kind = "chat", message = "检测失败：" + chatPingError, models = settings.ChatModels, selected = settings.ChatModel });
        }
        settings.Save();
        await Send("unlockState", new { unlocked = IsUnlocked() });
    }

    private bool IsUnlocked()
    {
        return imageConnected && chatConnected &&
            !String.IsNullOrWhiteSpace(settings.ImageBaseUrl) && !String.IsNullOrWhiteSpace(settings.ChatBaseUrl) &&
            !String.IsNullOrWhiteSpace(settings.ImageApiKey) && !String.IsNullOrWhiteSpace(settings.ChatApiKey);
    }

    private async Task PickAnalysisImage()
    {
        string path = PickOneImage();
        if (path != null) await Send("analysisImage", FilePayload(path));
    }

    private async Task PickEditImages(int existing)
    {
        List<object> files = PickManyImages(3 - existing);
        await Send("editImages", files);
    }

    private async Task DropAnalysis(Dictionary<string, object> payload)
    {
        foreach (string path in AsStrings(payload["files"])) { await Send("analysisImage", FilePayload(path)); return; }
    }

    private async Task DropEdit(Dictionary<string, object> payload)
    {
        int existing = Convert.ToInt32(payload["existing"]);
        var result = new List<object>();
        foreach (string path in AsStrings(payload["files"]))
        {
            if (result.Count + existing >= 3) break;
            if (File.Exists(path)) result.Add(FilePayload(path));
        }
        await Send("editImages", result);
    }

    private async Task Analyze(Dictionary<string, object> payload)
    {
        var s = ToSettings(payload["settings"] as Dictionary<string, object>);
        var image = payload["image"] as Dictionary<string, object>;
        if (image == null) throw new Exception("请先选择分析图像。");
        Stopwatch sw = Stopwatch.StartNew();
        Exception failure = null;
        try
        {
            string analysisMime;
            string analysisBase64 = PrepareImageForAnalysis(S(image, "mime"), S(image, "base64"), out analysisMime);
            var response = await ApiClient.Analyze(s.ChatBaseUrl, s.ChatApiKey, s.ChatModel, analysisMime, analysisBase64);
            sw.Stop();
            AnalysisResult result = ParseAnalysis(response);
            history.Add(new HistoryItem("图像分析", "成功", s.ChatModel, S(image, "name"), FormatDuration(sw.ElapsedMilliseconds), result.EditingPrompt, "", String.Join(Environment.NewLine, result.Issues.ToArray()), result.NegativePrompt, result.Rationale, "", "", new object[] { ImageHistoryPayload(image) }));
            await Send("analysisResult", new {
                meta = "完成时间：" + Now() + " · 处理耗时：" + FormatDuration(sw.ElapsedMilliseconds),
                issues = String.Join(Environment.NewLine, result.Issues.ToArray()) + Environment.NewLine + Environment.NewLine + "优化思路：" + result.Rationale,
                prompt = result.EditingPrompt,
                negative = result.NegativePrompt,
                history = history.LoadLatest(200)
            });
        }
        catch (Exception ex)
        {
            sw.Stop();
            failure = ex;
            history.Add(new HistoryItem("图像分析", "失败", s.ChatModel, S(image, "name"), FormatDuration(sw.ElapsedMilliseconds), "", Friendly(ex), "", "", "", "", "", new object[] { ImageHistoryPayload(image) }));
        }
        if (failure != null)
        {
            await Send("history", new { history = history.LoadLatest(200) });
            throw failure;
        }
    }

    private async Task Edit(Dictionary<string, object> payload)
    {
        var s = ToSettings(payload["settings"] as Dictionary<string, object>);
        var images = ToDictList(payload["images"]);
        HydrateImagePayloads(images);
        if (images.Count == 0) throw new Exception("请至少添加一张绘图编辑图像。");
        if (images.Count > 3) throw new Exception("最多只能添加三张图像。");
        string prompt = S(payload, "prompt");
        if (String.IsNullOrWhiteSpace(prompt)) throw new Exception("请输入绘图提示词。");
        Stopwatch sw = Stopwatch.StartNew();
        var first = images[0];
        Exception failure = null;
        try
        {
            var response = await ApiClient.Edit(s.ImageBaseUrl, s.ImageApiKey, s.ImageModel, prompt, images, S(payload, "size"), S(payload, "quality"));
            string dataUrl = ExtractImageDataUrl(response);
            string savedPath = await SaveImageToLocal(dataUrl);
            sw.Stop();
            object outputImage = FilePayload(savedPath);
            history.Add(new HistoryItem("图像编辑对话", "成功", s.ImageModel, S(first, "name"), FormatDuration(sw.ElapsedMilliseconds), prompt, "", "", "", "", savedPath, dataUrl, HistoryImagePayloads(images)));
            await Send("editResult", new { prompt = prompt, dataUrl = dataUrl, path = savedPath, outputImage = outputImage, history = history.LoadLatest(200) });
        }
        catch (Exception ex)
        {
            sw.Stop();
            failure = ex;
            history.Add(new HistoryItem("图像编辑对话", "失败", s.ImageModel, S(first, "name"), FormatDuration(sw.ElapsedMilliseconds), prompt, Friendly(ex), "", "", "", "", "", HistoryImagePayloads(images)));
        }
        if (failure != null)
        {
            await Send("history", new { history = history.LoadLatest(200) });
            throw failure;
        }
    }

    private object ImageHistoryPayload(Dictionary<string, object> image)
    {
        return new { name = S(image, "name"), path = S(image, "path"), mime = S(image, "mime"), dataUrl = S(image, "dataUrl") };
    }

    private object[] HistoryImagePayloads(List<Dictionary<string, object>> images)
    {
        var result = new List<object>();
        foreach (var image in images) result.Add(ImageHistoryPayload(image));
        return result.ToArray();
    }

    private void HydrateImagePayloads(List<Dictionary<string, object>> images)
    {
        foreach (var image in images)
        {
            if (!String.IsNullOrWhiteSpace(S(image, "base64"))) continue;
            string path = S(image, "path");
            if (!File.Exists(path)) continue;
            string mime = InferMime(path);
            image["name"] = String.IsNullOrWhiteSpace(S(image, "name")) ? Path.GetFileName(path) : S(image, "name");
            image["mime"] = mime;
            image["base64"] = Convert.ToBase64String(File.ReadAllBytes(path));
            image["dataUrl"] = "data:" + mime + ";base64," + image["base64"];
        }
    }

    private async Task HydrateEditSession(Dictionary<string, object> payload)
    {
        await Send("editSessionHydrated", new { sessionId = S(payload, "sessionId"), turns = HydrateTurns(ToDictList(payload["turns"])) });
    }

    private object FilePayload(string path)
    {
        string mime = InferMime(path);
        string b64 = Convert.ToBase64String(File.ReadAllBytes(path));
        return new { name = Path.GetFileName(path), path = path, mime = mime, base64 = b64, dataUrl = "data:" + mime + ";base64," + b64 };
    }

    private object[] HydrateTurns(List<Dictionary<string, object>> turns)
    {
        var result = new List<object>();
        foreach (var turn in turns)
        {
            var hydrated = new Dictionary<string, object>();
            foreach (var pair in turn) hydrated[pair.Key] = pair.Value;
            string path = S(turn, "path");
            if (String.IsNullOrWhiteSpace(S(turn, "dataUrl")) && File.Exists(path)) hydrated["dataUrl"] = DataUrlFromPath(path);
            var output = turn.ContainsKey("outputImage") ? turn["outputImage"] as Dictionary<string, object> : null;
            if (output != null)
            {
                string outputPath = S(output, "path");
                if (String.IsNullOrWhiteSpace(S(output, "dataUrl")) && File.Exists(outputPath)) hydrated["outputImage"] = FilePayload(outputPath);
            }
            hydrated["sourceImages"] = HydrateImages(ToDictList(turn.ContainsKey("sourceImages") ? turn["sourceImages"] : null));
            result.Add(hydrated);
        }
        return result.ToArray();
    }

    private object[] HydrateImages(List<Dictionary<string, object>> images)
    {
        var result = new List<object>();
        foreach (var image in images)
        {
            string path = S(image, "path");
            if (String.IsNullOrWhiteSpace(S(image, "dataUrl")) && File.Exists(path)) result.Add(FilePayload(path));
            else result.Add(image);
        }
        return result.ToArray();
    }

    private string DataUrlFromPath(string path)
    {
        return "data:" + InferMime(path) + ";base64," + Convert.ToBase64String(File.ReadAllBytes(path));
    }

    private string PickOneImage()
    {
        using (var d = new OpenFileDialog()) { d.Filter = "图像文件|*.jpg;*.jpeg;*.png;*.raw;*.dng;*.cr2;*.nef;*.arw;*.rw2;*.orf;*.raf|所有文件|*.*"; return d.ShowDialog(this) == DialogResult.OK ? d.FileName : null; }
    }

    private List<object> PickManyImages(int max)
    {
        var result = new List<object>();
        if (max <= 0) return result;
        using (var d = new OpenFileDialog()) {
            d.Multiselect = true; d.Filter = "图像文件|*.jpg;*.jpeg;*.png;*.raw;*.dng;*.cr2;*.nef;*.arw;*.rw2;*.orf;*.raf|所有文件|*.*";
            if (d.ShowDialog(this) == DialogResult.OK) foreach (string p in d.FileNames) { if (result.Count >= max) break; result.Add(FilePayload(p)); }
        }
        return result;
    }

    private AppSettings ToSettings(Dictionary<string, object> s)
    {
        settings.ImageBaseUrl = First(s, "imageBaseUrl", "ImageBaseUrl");
        settings.ImageApiKey = First(s, "imageApiKey", "ImageApiKey");
        settings.ImageModel = First(s, "imageModel", "ImageModel");
        settings.ChatBaseUrl = First(s, "chatBaseUrl", "ChatBaseUrl");
        settings.ChatApiKey = First(s, "chatApiKey", "ChatApiKey");
        settings.ChatModel = First(s, "chatModel", "ChatModel");
        settings.Save();
        return settings;
    }

    private Task Send(string type, object payload)
    {
        web.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { type = type, payload = payload }));
        return Task.FromResult(0);
    }
    private static string S(Dictionary<string, object> d, string k) { return d != null && d.ContainsKey(k) && d[k] != null ? Convert.ToString(d[k]) : ""; }
    private static string First(Dictionary<string, object> d, params string[] keys) { foreach (string key in keys) { string value = S(d, key); if (!String.IsNullOrWhiteSpace(value)) return value; } return ""; }
    private static string Now() { return DateTime.Now.ToString("yyyy/M/d HH:mm:ss"); }
    private static string FormatDuration(long ms) { return ms < 1000 ? ms + " ms" : (ms / 1000.0).ToString("0.0") + " 秒"; }
    private static string Friendly(Exception ex)
    {
        StringBuilder sb = new StringBuilder();
        Exception current = ex;
        while (current != null)
        {
            if (sb.Length > 0) sb.Append(" | ");
            sb.Append(current.Message);
            current = current.InnerException;
        }
        string m = sb.Length == 0 ? "未知错误" : sb.ToString();
        return m.Length > 1600 ? m.Substring(0, 1600) + "..." : m;
    }
    private static string InferMime(string path) { string e = Path.GetExtension(path).ToLowerInvariant(); if (e == ".jpg" || e == ".jpeg") return "image/jpeg"; if (e == ".png") return "image/png"; if (e == ".dng") return "image/x-adobe-dng"; return "application/octet-stream"; }

    private IEnumerable<string> AsStrings(object value) { var e = value as IEnumerable; if (e != null) foreach (object x in e) yield return Convert.ToString(x); }
    private List<Dictionary<string, object>> ToDictList(object value) { var list = new List<Dictionary<string, object>>(); var e = value as IEnumerable; if (e != null) foreach (object x in e) { var d = x as Dictionary<string, object>; if (d != null) list.Add(d); } return list; }

    private string PrepareImageForAnalysis(string mime, string imageBase64, out string outputMime)
    {
        outputMime = String.IsNullOrWhiteSpace(mime) ? "image/jpeg" : mime;
        try
        {
            byte[] input = Convert.FromBase64String(imageBase64);
            using (MemoryStream source = new MemoryStream(input))
            using (Image image = Image.FromStream(source))
            {
                int maxSide = Math.Max(image.Width, image.Height);
                if (maxSide <= 1600 && input.Length <= 1800 * 1024) return imageBase64;
                double scale = Math.Min(1600.0 / image.Width, 1600.0 / image.Height);
                int width = Math.Max(1, (int)Math.Round(image.Width * scale));
                int height = Math.Max(1, (int)Math.Round(image.Height * scale));
                using (Bitmap resized = new Bitmap(width, height))
                using (Graphics graphics = Graphics.FromImage(resized))
                using (MemoryStream output = new MemoryStream())
                {
                    graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
                    graphics.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                    graphics.DrawImage(image, 0, 0, width, height);
                    ImageCodecInfo jpg = GetJpegCodec();
                    if (jpg != null)
                    {
                        EncoderParameters enc = new EncoderParameters(1);
                        enc.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 82L);
                        resized.Save(output, jpg, enc);
                    }
                    else
                    {
                        resized.Save(output, ImageFormat.Jpeg);
                    }
                    outputMime = "image/jpeg";
                    return Convert.ToBase64String(output.ToArray());
                }
            }
        }
        catch
        {
            return imageBase64;
        }
    }

    private static ImageCodecInfo GetJpegCodec()
    {
        ImageCodecInfo[] codecs = ImageCodecInfo.GetImageEncoders();
        foreach (ImageCodecInfo codec in codecs)
        {
            if (codec.MimeType == "image/jpeg") return codec;
        }
        return null;
    }

    private List<string> ExtractModels(Dictionary<string, object> data) { var list = new List<string>(); if (data != null && data.ContainsKey("data")) AddModelIds(data["data"], list); if (data != null && data.ContainsKey("models")) AddModelIds(data["models"], list); return new List<string>(new SortedSet<string>(list, StringComparer.OrdinalIgnoreCase)); }
    private void AddModelIds(object value, List<string> list) { if (value == null) return; if (value is string) { list.Add((string)value); return; } var d = value as Dictionary<string, object>; if (d != null) { if (d.ContainsKey("id")) AddModelIds(d["id"], list); else if (d.ContainsKey("model")) AddModelIds(d["model"], list); return; } var e = value as IEnumerable; if (e != null) foreach (object x in e) AddModelIds(x, list); }
    private List<string> FilterModels(List<string> models, bool image) { var f = new List<string>(); foreach (string model in models) { string m = model.ToLowerInvariant(); if (image ? (m.Contains("image") || m.Contains("dall")) : (m.Contains("gpt") || m.Contains("vision") || m.Contains("o3") || m.Contains("o4"))) f.Add(model); } return f.Count > 0 ? f : models; }
    private string Prefer(List<string> models, params string[] names) { foreach (string n in names) foreach (string m in models) if (String.Equals(m, n, StringComparison.OrdinalIgnoreCase)) return m; if (models.Count > 0) return models[0]; foreach (string n in names) if (!String.IsNullOrWhiteSpace(n)) return n; return ""; }

    private AnalysisResult ParseAnalysis(Dictionary<string, object> response) { string text = CleanJsonText(ApiClient.ExtractResponseText(response)); try { var d = json.Deserialize<Dictionary<string, object>>(text); var r = new AnalysisResult(); if (d.ContainsKey("issues")) foreach (object x in (IEnumerable)d["issues"]) r.Issues.Add(Convert.ToString(x)); r.EditingPrompt = d.ContainsKey("editing_prompt") ? Convert.ToString(d["editing_prompt"]) : text; r.NegativePrompt = d.ContainsKey("negative_prompt") ? Convert.ToString(d["negative_prompt"]) : ""; r.Rationale = d.ContainsKey("rationale") ? Convert.ToString(d["rationale"]) : ""; return r; } catch { return new AnalysisResult { EditingPrompt = text, Rationale = "模型没有返回标准 JSON，已保留原文。" }; } }
    private string CleanJsonText(string text) { text = (text ?? "").Trim(); int s = text.IndexOf('{'), e = text.LastIndexOf('}'); return s >= 0 && e > s ? text.Substring(s, e - s + 1) : text; }

    private string ExtractImageDataUrl(Dictionary<string, object> response) { string b64 = FindString(response, "b64_json"); if (!String.IsNullOrEmpty(b64)) return "data:image/png;base64," + b64; string url = FindString(response, "url"); if (!String.IsNullOrEmpty(url)) return url; string img = FindString(response, "image"); if (!String.IsNullOrEmpty(img)) return img.StartsWith("data:image") ? img : "data:image/png;base64," + img; throw new Exception("绘图接口没有返回可识别图像。"); }
    private string FindString(object current, string key) { var d = current as Dictionary<string, object>; if (d != null) { foreach (var p in d) { if (String.Equals(p.Key, key, StringComparison.OrdinalIgnoreCase)) return Convert.ToString(p.Value); string x = FindString(p.Value, key); if (!String.IsNullOrEmpty(x)) return x; } } var e = current as IEnumerable; if (e != null && !(current is string)) foreach (object x in e) { string y = FindString(x, key); if (!String.IsNullOrEmpty(y)) return y; } return ""; }
    private async Task<string> SaveImageToLocal(string dataUrl)
    {
        string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyPictures), "ImagePromptOptimizer");
        Directory.CreateDirectory(dir);
        string path = Path.Combine(dir, "edited-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".png");
        if (dataUrl.StartsWith("data:image"))
        {
            File.WriteAllBytes(path, Convert.FromBase64String(dataUrl.Substring(dataUrl.IndexOf(',') + 1)));
            return path;
        }
        if (dataUrl.StartsWith("http://") || dataUrl.StartsWith("https://"))
        {
            using (HttpClient client = new HttpClient { Timeout = TimeSpan.FromSeconds(120) })
            {
                byte[] bytes = await client.GetByteArrayAsync(dataUrl);
                File.WriteAllBytes(path, bytes);
                return path;
            }
        }
        throw new Exception("绘图接口返回了无法保存的图像地址。");
    }
}

public static class ApiClient
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue, RecursionLimit = 100 };

    public static async Task<Dictionary<string, object>> Analyze(string baseUrl, string apiKey, string model, string mime, string imageBase64)
    {
        string imageUrl = "data:" + mime + ";base64," + imageBase64;
        var body = new Dictionary<string, object> {
            { "model", model },
            { "messages", new object[] {
                new Dictionary<string, object> { { "role", "system" }, { "content", "You are a professional image retouching prompt engineer. Return JSON only. All values must be Simplified Chinese." } },
                new Dictionary<string, object> {
                    { "role", "user" },
                    { "content", new object[] {
                        new Dictionary<string, object> { { "type", "text" }, { "text", "分析图像不足并返回 JSON：issues 数组、editing_prompt、negative_prompt、rationale。保留主体身份和构图意图，给出适合图像编辑模型的中文提示词。" } },
                        new Dictionary<string, object> { { "type", "image_url" }, { "image_url", new Dictionary<string, object> { { "url", imageUrl } } } }
                    } }
                }
            } },
            { "response_format", new Dictionary<string, object> { { "type", "json_object" } } }
        };
        Exception firstFailure = null;
        try
        {
            return await InvokeJson("POST", baseUrl, apiKey, "/v1/chat/completions", body, 300);
        }
        catch (Exception first)
        {
            firstFailure = first;
        }
        string message = firstFailure.Message ?? "";
        if (message.IndexOf("response_format", StringComparison.OrdinalIgnoreCase) < 0 &&
            message.IndexOf("json", StringComparison.OrdinalIgnoreCase) < 0 &&
            message.IndexOf("400") < 0)
        {
            throw firstFailure;
        }
        body.Remove("response_format");
        return await InvokeJson("POST", baseUrl, apiKey, "/v1/chat/completions", body, 300);
    }

    public static async Task<Dictionary<string, object>> Edit(string baseUrl, string apiKey, string model, string prompt, List<Dictionary<string, object>> images, string size, string quality)
    {
        Exception multipartError = null;
        try
        {
            using (HttpClient client = NewClient(apiKey, 300))
            using (MultipartFormDataContent form = new MultipartFormDataContent())
            {
                AddString(form, "model", model);
                AddString(form, "prompt", prompt);
                AddString(form, "size", size);
                AddString(form, "quality", quality);
                AddString(form, "response_format", "b64_json");
                for (int i = 0; i < images.Count; i++)
                {
                    var img = images[i];
                    byte[] bytes = Convert.FromBase64String(Convert.ToString(img["base64"]));
                    string mime = img.ContainsKey("mime") ? Convert.ToString(img["mime"]) : "application/octet-stream";
                    string fileName = img.ContainsKey("name") ? Convert.ToString(img["name"]) : "image-" + i + ".png";
                    var file = new ByteArrayContent(bytes);
                    file.Headers.ContentType = MediaTypeHeaderValue.Parse(String.IsNullOrEmpty(mime) ? "application/octet-stream" : mime);
                    form.Add(file, i == 0 ? "image" : "image[]", String.IsNullOrEmpty(fileName) ? "image.png" : fileName);
                }
                HttpResponseMessage response = await client.PostAsync(Normalize(baseUrl) + "/v1/images/edits", form);
                string text = await response.Content.ReadAsStringAsync();
                if (!response.IsSuccessStatusCode) throw new Exception(text);
                return Json.Deserialize<Dictionary<string, object>>(text);
            }
        }
        catch (Exception ex) { multipartError = ex; }

        ArrayList imageUrls = new ArrayList();
        ArrayList imageUrlObjects = new ArrayList();
        ArrayList typedFlatImageUrlObjects = new ArrayList();
        ArrayList imageUrlNestedObjects = new ArrayList();
        ArrayList typedImageUrlObjects = new ArrayList();
        foreach (var img in images)
        {
            string mime = img.ContainsKey("mime") ? Convert.ToString(img["mime"]) : "application/octet-stream";
            string imageBase64 = Convert.ToString(img["base64"]);
            if (String.IsNullOrWhiteSpace(imageBase64)) throw new Exception("当前图像缺少可编辑的 base64 数据，请重新添加图像。");
            string dataUrl = "data:" + mime + ";base64," + imageBase64;
            imageUrls.Add(dataUrl);
            imageUrlObjects.Add(new Dictionary<string, object> { { "image_url", dataUrl } });
            typedFlatImageUrlObjects.Add(new Dictionary<string, object> { { "type", "image_url" }, { "image_url", dataUrl } });
            imageUrlNestedObjects.Add(new Dictionary<string, object> { { "image_url", new Dictionary<string, object> { { "url", dataUrl } } } });
            typedImageUrlObjects.Add(new Dictionary<string, object> { { "type", "image_url" }, { "image_url", new Dictionary<string, object> { { "url", dataUrl } } } });
        }
        var failures = new List<string>();
        var bodies = new List<Dictionary<string, object>>();
        bodies.Add(ImageEditBody(model, prompt, size, quality, "images", imageUrlObjects));
        bodies.Add(ImageEditBody(model, prompt, size, quality, "images", typedFlatImageUrlObjects));
        bodies.Add(ImageEditBody(model, prompt, size, quality, "images", imageUrlNestedObjects));
        bodies.Add(ImageEditBody(model, prompt, size, quality, "images", typedImageUrlObjects));
        foreach (var body in bodies)
        {
            try { return await InvokeJson("POST", baseUrl, apiKey, "/v1/images/edits", body, 300); }
            catch (Exception json) { failures.Add(json.Message); }
        }
        throw new Exception("图像编辑请求失败。Multipart: " + ShortError(multipartError.Message) + Environment.NewLine + "JSON: " + ShortError(failures.Count > 0 ? failures[0] : "无返回"));
    }

    private static Dictionary<string, object> ImageEditBody(string model, string prompt, string size, string quality, string imageKey, object imageValue)
    {
        return new Dictionary<string, object> {
            { "model", model },
            { "prompt", prompt },
            { imageKey, imageValue },
            { "size", size },
            { "quality", quality },
            { "response_format", "b64_json" }
        };
    }
    private static string ShortError(string value)
    {
        string v = String.IsNullOrWhiteSpace(value) ? "未知错误" : value.Replace("\r", " ").Replace("\n", " ");
        return v.Length > 500 ? v.Substring(0, 500) + "..." : v;
    }
    public static async Task<Dictionary<string, object>> InvokeJson(string method, string baseUrl, string apiKey, string path, object body, int timeoutSeconds)
    {
        using (HttpClient client = NewClient(apiKey, timeoutSeconds))
        {
            HttpResponseMessage response;
            if (method == "GET") response = await client.GetAsync(Normalize(baseUrl) + path);
            else response = await client.PostAsync(Normalize(baseUrl) + path, new StringContent(Json.Serialize(body), Encoding.UTF8, "application/json"));
            string text = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode) throw new Exception(text);
            return Json.Deserialize<Dictionary<string, object>>(text);
        }
    }

    public static string ExtractResponseText(Dictionary<string, object> response)
    {
        object text = Find(response, "content") ?? Find(response, "output_text");
        return text == null ? Json.Serialize(response) : Convert.ToString(text);
    }

    private static object Find(object current, string key)
    {
        var d = current as Dictionary<string, object>;
        if (d != null)
        {
            foreach (var p in d)
            {
                if (String.Equals(p.Key, key, StringComparison.OrdinalIgnoreCase)) return p.Value;
                object f = Find(p.Value, key);
                if (f != null) return f;
            }
        }
        var e = current as IEnumerable;
        if (e != null && !(current is string)) foreach (object x in e) { object f = Find(x, key); if (f != null) return f; }
        return null;
    }

    private static HttpClient NewClient(string apiKey, int timeoutSeconds)
    {
        var client = new HttpClient { Timeout = TimeSpan.FromSeconds(timeoutSeconds) };
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        client.DefaultRequestHeaders.ConnectionClose = true;
        return client;
    }
    private static void AddString(MultipartFormDataContent form, string name, string value) { if (!String.IsNullOrWhiteSpace(value)) form.Add(new StringContent(value, Encoding.UTF8), name); }
    private static string Normalize(string baseUrl) { string v = (baseUrl ?? "").Trim().TrimEnd('/'); if (v.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)) v = v.Substring(0, v.Length - 3).TrimEnd('/'); if (String.IsNullOrEmpty(v)) throw new Exception("URL 不能为空。"); return v; }
}

public sealed class AppSettings
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly string Dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ImagePromptOptimizer");
    private static readonly string FilePath = Path.Combine(Dir, "settings.json");
    public string ImageBaseUrl = "https://www.cctq.ai/v1", ImageApiKey = "", ImageModel = "";
    public string ChatBaseUrl = "https://www.cctq.ai/v1", ChatApiKey = "", ChatModel = "";
    public List<string> ImageModels = new List<string>(), ChatModels = new List<string>();
    public static AppSettings Load() { try { if (File.Exists(FilePath)) return Json.Deserialize<AppSettings>(File.ReadAllText(FilePath, Encoding.UTF8)); } catch { } return new AppSettings(); }
    public void Save() { Directory.CreateDirectory(Dir); File.WriteAllText(FilePath, Json.Serialize(this), Encoding.UTF8); }
}

public sealed class HistoryItem
{
    public string CreatedAt, Action, Status, Model, FileName, Duration, Prompt, Error, Issues, NegativePrompt, Rationale, OutputPath, OutputDataUrl;
    public object[] InputImages;
    public HistoryItem() { }
    public HistoryItem(string action, string status, string model, string fileName, string duration, string prompt, string error, string issues, string negativePrompt, string rationale, string outputPath, string outputDataUrl, object[] inputImages)
    {
        CreatedAt = DateTime.Now.ToString("yyyy/M/d HH:mm:ss"); Action = action; Status = status; Model = model; FileName = fileName; Duration = duration; Prompt = Trunc(prompt, 6000); Error = Trunc(error, 3000); Issues = Trunc(issues, 4000); NegativePrompt = Trunc(negativePrompt, 3000); Rationale = Trunc(rationale, 3000); OutputPath = outputPath ?? ""; OutputDataUrl = outputDataUrl ?? ""; InputImages = inputImages ?? new object[0];
    }
    private static string Trunc(string v, int max) { v = v ?? ""; return v.Length > max ? v.Substring(0, max) + "..." : v; }
}

public sealed class HistoryStore
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
    private static readonly string Dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ImagePromptOptimizer");
    private static readonly string FilePath = Path.Combine(Dir, "history.jsonl");
    public void Add(HistoryItem item) { Directory.CreateDirectory(Dir); File.AppendAllText(FilePath, Json.Serialize(item) + Environment.NewLine, Encoding.UTF8); }
    public List<HistoryItem> LoadLatest(int count)
    {
        if (!File.Exists(FilePath)) return new List<HistoryItem>();
        string[] lines = File.ReadAllLines(FilePath, Encoding.UTF8);
        var result = new List<HistoryItem>();
        for (int i = lines.Length - 1; i >= 0 && result.Count < count; i--) { try { result.Add(Slim(Json.Deserialize<HistoryItem>(lines[i]))); } catch { } }
        return result;
    }
    private HistoryItem Slim(HistoryItem item)
    {
        if (item == null) return item;
        item.OutputDataUrl = "";
        bool edit = IsEditHistory(item);
        if (item.InputImages == null) return item;
        for (int i = 0; i < item.InputImages.Length; i++)
        {
            var image = item.InputImages[i] as Dictionary<string, object>;
            if (image == null) continue;
            if (edit)
            {
                string path = image.ContainsKey("path") ? Convert.ToString(image["path"]) : "";
                if (!String.IsNullOrWhiteSpace(path))
                {
                    image["dataUrl"] = "";
                    image["base64"] = "";
                }
            }
        }
        return item;
    }
    private static bool IsEditHistory(HistoryItem item)
    {
        string action = item.Action ?? "";
        return action.Contains("图像编辑") || action.Contains("绘图模型编辑") || action == "调用绘图模型编辑";
    }
    public void Clear() { if (File.Exists(FilePath)) File.Delete(FilePath); }
}

public sealed class AnalysisResult
{
    public List<string> Issues = new List<string>();
    public string EditingPrompt = "", NegativePrompt = "", Rationale = "";
}
