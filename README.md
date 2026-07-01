# 图像提示词优化器

一个面向 Windows 的图像优化工作台。它把图像分析、提示词生成和多轮图像编辑放在同一个桌面应用里：先用对话/视觉模型分析原图问题，生成适合绘图模型的中文编辑提示词，再像聊天一样连续提交图像编辑任务。

## 主要功能

- 双服务接入：分别配置绘图服务和对话服务的 API Base URL、API Key，并自动读取可用模型。
- 启动解锁：已保存的服务配置会在启动时自动检测，两个服务都联通后进入工作台。
- 图像分析：上传或拖拽单张图片，让视觉模型输出图像不足、优化思路、编辑提示词和负面提示词。
- 图像编辑：每次最多携带 3 张图，选择绘图模型、尺寸和质量后生成编辑结果。
- 多轮编辑：生成图可以继续作为下一轮输入，历史记录会按图像编辑对话聚合。
- 本地历史：最近的分析记录和编辑会话保存在本机，侧边栏可快速恢复。
- 本地落盘：生成图片会保存到 Windows 图片目录下的 `ImagePromptOptimizer` 文件夹。

## 运行环境

- Windows 10/11
- Microsoft Edge WebView2 Runtime
- 可兼容 OpenAI 风格接口的服务：
  - `/v1/models`
  - `/v1/chat/completions`
  - `/v1/images/edits`

如果应用打开后是空白窗口，请安装 Microsoft Edge WebView2 Runtime：

```text
https://developer.microsoft.com/microsoft-edge/webview2/
```

## 快速开始

### 直接运行

仓库根目录包含已经构建好的桌面程序：

```text
ImagePromptOptimizer.exe
webview-dist/
Microsoft.Web.WebView2.Core.dll
Microsoft.Web.WebView2.WinForms.dll
WebView2Loader.dll
```

双击 `ImagePromptOptimizer.exe` 即可启动。首次启动需要分别填写绘图服务和对话服务的 URL、API Key，然后点击“测试联通并读取模型”。

## 使用流程

1. 打开应用，进入“连接模型服务”页面。
2. 分别填写绘图服务和对话服务的 Base URL、API Key。
3. 点击两个服务卡片里的“测试联通并读取模型”。
4. 服务检测通过后，进入“图像分析”或“图像编辑”。
5. 在“图像分析”中上传原图，生成问题分析、编辑提示词和负面提示词。
6. 在“图像编辑”中添加最多 3 张图，输入提示词，选择模型、尺寸、质量后发送。
7. 生成后的图片可以继续点击“编辑”，作为下一轮输入。

## 本地数据

配置和历史记录保存在：

```text
%LOCALAPPDATA%\ImagePromptOptimizer
```

生成图片默认保存到：

```text
%USERPROFILE%\Pictures\ImagePromptOptimizer
```

卸载脚本位置：

```text
%LOCALAPPDATA%\ImagePromptOptimizer\Uninstall.ps1
```

卸载脚本只删除程序文件和快捷方式，默认保留配置与历史记录。

## 从源码构建

### 构建前端

前端使用 React + Vite：

```powershell
cd frontend
npm install
npm run build
```

构建产物会输出到仓库根目录：

```text
webview-dist/
```

### 构建安装包

安装包依赖 `installer/sfx/ImagePromptOptimizerPayload.zip`。确认 payload 已包含最新版程序文件后运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File installer\build-setup.ps1
```

生成结果：

```text
给同学安装包/ImagePromptOptimizer-Setup.exe
```

## 项目结构

```text
frontend/                         React + Vite 前端源码
webview-dist/                     桌面端加载的前端构建产物
ImagePromptOptimizerLauncher.cs   WinForms + WebView2 桌面外壳源码
ImagePromptOptimizer.exe          当前已构建的桌面程序
installer/                        安装包脚本和 SFX payload
packages/                         WebView2 NuGet 包
public/, webview/                 早期网页版本文件
start.ps1                         早期本地 HTTP 版本启动脚本
```

## 隐私说明

项目不会内置 API Key。用户填写的服务地址、Key、模型列表和历史记录都保存在本机 `%LOCALAPPDATA%\ImagePromptOptimizer` 下，不会提交到仓库。
