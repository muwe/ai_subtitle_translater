document.addEventListener("DOMContentLoaded", () => {
    const enableToggle = document.getElementById("enableToggle");
    const toggle = document.getElementById("bilingualToggle");
    const langSelect = document.getElementById("targetLang");
    const providerItems = document.querySelectorAll('.provider-item');
    const statusText = document.getElementById("statusText");

    // Load saved settings
    chrome.storage.sync.get({
        pluginEnabled: true,
        bilingualMode: false,
        preferredProvider: 0,
        targetLang: 'zh-CN'
    }, (data) => {
        if (enableToggle) enableToggle.checked = data.pluginEnabled;
        if (toggle) toggle.checked = data.bilingualMode;
        if (langSelect) langSelect.value = data.targetLang;
        selectProvider(data.preferredProvider);
    });

    // Enable toggle
    if (enableToggle) {
        enableToggle.addEventListener("change", (e) => {
            chrome.storage.sync.set({ pluginEnabled: e.target.checked });
        });
    }

    // Bilingual toggle
    if (toggle) {
        toggle.addEventListener("change", (e) => {
            chrome.storage.sync.set({ bilingualMode: e.target.checked });
        });
    }

    // Target language
    if (langSelect) {
        langSelect.addEventListener("change", (e) => {
            const lang = e.target.value;
            chrome.storage.sync.set({ targetLang: lang });
            chrome.runtime.sendMessage({ action: 'setTargetLang', lang });
            if (statusText) statusText.innerHTML = `<span class="status-dot"></span>Re-translating subtitles...`;
        });
    }

    // Provider selection
    providerItems.forEach(item => {
        item.addEventListener('click', () => {
            const value = parseInt(item.dataset.provider);
            selectProvider(value);
            chrome.storage.sync.set({ preferredProvider: value });
            chrome.runtime.sendMessage({ action: 'setProvider', provider: value });
        });
    });

    function selectProvider(index) {
        providerItems.forEach(item => {
            const idx = parseInt(item.dataset.provider);
            item.classList.toggle('selected', idx === index);
            const radio = item.querySelector('input[type=radio]');
            if (radio) radio.checked = (idx === index);
        });
    }

    // Load current status
    chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
        if (chrome.runtime.lastError || !response) return;
        if (response.activeProvider !== undefined) {
            selectProvider(response.activeProvider);
            const names = ['Google', 'Bing', 'MyMemory', 'Lingva'];
            const name = names[response.activeProvider] || 'Unknown';
            if (statusText) statusText.innerHTML = `<span class="status-dot"></span>Active: ${name} · Cached: ${response.cacheSize || 0}`;
        }
    });
});
