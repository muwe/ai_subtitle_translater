# Universal Subtitle Translator 🌐 (全网视频字幕翻译器)

[ 🇨🇳 简体中文 | [🇬🇧 English (English)](README.md) ]

一款强大的、开源的 Chrome 视频双语字幕翻译插件。它能够动态拦截网络传输环境中的字幕，通过多个自动回退引擎进行实时翻译，并将其无缝地重新注入视频播放器中，丝毫不影响浏览器的性能或导致页面卡顿。

### 核心特性 ✨
* **真实的双语沉浸**: 同时显示原生字幕结构与翻译后的字幕内容。
* **智能请求降级 (防死锁)**: 默认全速使用 `Google 翻译`，当遭遇服务器频率限制被阻断时，系统会在千分之一秒内无缝切换至 `Microsoft Bing`，`MyMemory` 或 `Lingva` 进行代传。
* **零 CSS 性能损耗**: 在针对 YouTube 的优化中，它深度劫持了基于 fetch / XHR 到底层的请求流，在网页渲染字幕前就直接改写了数据源。
* **全栈兼容拦截器**: 针对 VideoJS, Shaka 等自定义 HTML5 的浮动字幕容器进行了动态挂载监听。

### 安装指南 🛠️
1. 以 Zip 格式下载或直接克隆本仓库到你的电脑：
   ```bash
   git clone https://github.com/muwe/ai_subtitle_translater.git
   ```
2. 打开 Google Chrome 或其他 Chromium 内核浏览器，在地址栏输入 `chrome://extensions/`。
3. 开启页面右上角的 **“开发者模式” (Developer mode)** 。
4. 点击左上角的 **“加载已解压的扩展程序” (Load unpacked)**，并选择刚刚下载好的完整文件夹。
5. 将插件固定到工具栏，随便打开一个含有 CC 字幕的视频，大功告成！

### 运行机制 💡
这款插件之所以比市面上那些不停扫描页面的“笨重机器”快得多，是因为它跳过了 DOM 层面的物理轮询。通过在 `MAIN` 世界（网页宿主环境）注入微小脚本并打补丁 (monkey-patching) 监听原生的 `XMLHttpRequest`，我们能够在视频数据流刚刚进入内存时就把它截流下来。

由于所有跨域请求均转由 Chrome 后台的 `Service Worker` 并发行列处理，我们彻底避免了严格网页的 CORS (跨域资源共享) 拦截限制。

---

## 参与贡献 🤝
欢迎任何人贡献代码！无论你是想接入新的翻译平台，还是优化更底层的渲染逻辑，提交 Pull Request 我们都会认真对待。

## 开源协议 📄
本项目遵循极其宽松的 [MIT License](LICENSE) 协议。
