# 图像提示词优化器

一个 Windows 桌面工具，用于分析图片问题、生成适合图像编辑模型的中文优化提示词，并支持调用图像编辑接口生成修图结果。

## 功能

- 上传或拖入图片，让聊天/视觉模型分析画面不足。
- 自动生成中文图像编辑提示词、负面提示词和优化思路。
- 调用图像编辑模型进行图片编辑。
- 支持配置自定义 API Base URL、API Key 和模型。
- 自动保存最近的分析/编辑历史。
- 提供 Windows 桌面版安装器。

## 快速安装

仓库中已经包含 Windows 安装器：

```text
release/ImagePromptOptimizer-Setup.exe
```

双击安装即可。安装后会创建桌面快捷方式和开始菜单快捷方式。

如果软件打开后是空白窗口，请安装 Microsoft Edge WebView2 Runtime：

```text
https://developer.microsoft.com/microsoft-edge/webview2/
```

## 使用说明

1. 打开软件。
2. 填写图像模型和聊天模型的 API Base URL、API Key。
3. 点击连接测试，获取可用模型列表。
4. 上传图片，先分析图片并生成提示词。
5. 根据需要调整提示词，再调用图像编辑模型生成结果。

配置和历史记录保存在当前用户目录：

```text
%LOCALAPPDATA%\ImagePromptOptimizer
```

## 从源码构建

前端使用 React + Vite：

```powershell
cd frontend
npm install
npm run build
```

构建产物会输出到项目根目录的 `webview-dist`。

刷新桌面版 release 文件：

```powershell
Copy-Item -Recurse -Force webview-dist release\webview-dist
```

重新生成 Windows 安装器：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File installer\build-setup.ps1
```

生成后的安装器位于：

```text
release/ImagePromptOptimizer-Setup.exe
```

## 项目结构

```text
frontend/                         React + Vite 前端源码
webview-dist/                     前端生产构建产物
ImagePromptOptimizerLauncher.cs   WinForms + WebView2 桌面壳源码
release/                          可运行发布文件和安装器
installer/                        安装器脚本和构建脚本
packages/                         WebView2 NuGet 包
public/, webview/                 早期网页版本文件
```

## 隐私说明

本仓库是私有仓库。软件本身不会内置 API Key；用户填写的配置保存在本机 `%LOCALAPPDATA%\ImagePromptOptimizer` 下，不会提交到仓库。

## 备注

本项目主要面向 Windows。桌面版依赖 Microsoft Edge WebView2 Runtime，大多数 Windows 10/11 系统已默认包含。
