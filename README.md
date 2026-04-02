# Universal Subtitle Translator 🌐

[ [🇨🇳 简体中文 (Chinese)](README_CN.md) | 🇬🇧 English ]

A powerful, open-source video subtitle translator extension for Chrome. It intercepts streaming subtitles dynamically, translates them in real-time, and seamlessly injects them back into the video player without freezing the browser.

### Features ✨
* **Seamless Dual Subtitles**: Display original and translated subtitles simultaneously.
* **Smart Engine Fallback**: Defaults to `Google Translate`, and automatically falls back to `Microsoft Bing`, `MyMemory`, or `Lingva` silently if hit by API rate-limits.
* **Zero CSS Hacks**: Directly intercepts XML/JSON XHR traffic on YouTube for native-level rendering speed.
* **Custom Floating DOM Tracker**: Tracks and updates floating captions on native HTML5 players, VideoJS, and Shaka player sites.

### Installation 🛠️
1. Download or clone this repository to your local machine:
   ```bash
   git clone https://github.com/muwe/ai_subtitle_translater.git
   ```
2. Open Google Chrome and go to `chrome://extensions/`.
3. Toggle on **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the folder you just cloned.
5. Pin the extension to your toolbar, open a video on YouTube or any HTML5 site, and start translating!

### How it works 💡
Instead of relying purely on heavy DOM Mutation Observers (which freeze browsers on complex DOM structures), this extension bridges isolated environments. It injects a tiny script into the `MAIN` page world that monkey-patches `XMLHttpRequest` and `fetch`. Once subtitle metadata is intercepted mid-air, it dispatches batches to the Chrome background Service Worker to utilize translation APIs, avoiding CORS restrictions entirely.

---

## Contribution 🤝
Pull requests are always welcome! Whether it's to add a new translation API or optimize rendering logic. 

## License 📄
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
