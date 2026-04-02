console.log("[Subtitle Translator] Content script loaded on", window.location.hostname);

// ========== Settings ==========
let pluginEnabled = true;
let bilingualMode = false;
let targetLang = 'zh-CN';
const translatedCues = []; // Track all translated cues for re-formatting

function addTranslatedCue(item) {
    translatedCues.push(item);
    if (translatedCues.length > 200) translatedCues.shift();
}

chrome.storage.sync.get({ pluginEnabled: true, bilingualMode: false, targetLang: 'zh-CN' }, (data) => {
    pluginEnabled = data.pluginEnabled;
    bilingualMode = data.bilingualMode;
    targetLang = data.targetLang;
    window.postMessage({ type: 'SUBTITLE_TRANSLATOR_SETTINGS', pluginEnabled, bilingualMode, targetLang }, '*');
});
chrome.storage.onChanged.addListener((changes) => {
    let settingsChanged = false;
    if (changes.pluginEnabled) {
        pluginEnabled = changes.pluginEnabled.newValue;
        settingsChanged = true;
        // Re-format native cues when turning on/off
        translatedCues.forEach(({ cue, original, translated }) => {
            try {
                if (!pluginEnabled) {
                    cue.text = original; // Revert to original
                } else {
                    cue.text = bilingualMode ? `${translated}\n${original}` : translated;
                }
            } catch(e) {}
        });
        
        // Re-format custom DOM subtitles
        document.querySelectorAll('[data-original-text]').forEach(target => {
            const orig = target.dataset.originalText;
            const translated = target.dataset.lastTranslatedText;
            const bilingual = target.dataset.lastBilingualText;
            if (!orig || !translated) return;
            
            if (!pluginEnabled) target.innerText = orig;
            else target.innerText = bilingualMode ? bilingual : translated;
        });
    }
    if (changes.bilingualMode) {
        bilingualMode = changes.bilingualMode.newValue;
        settingsChanged = true;
        
        // Re-format native cues with new mode if plugin is enabled
        if (pluginEnabled) {
            translatedCues.forEach(({ cue, original, translated }) => {
                try {
                    cue.text = bilingualMode ? `${translated}\n${original}` : translated;
                } catch(e) {}
            });
            
            // Re-format custom DOM subtitles
            document.querySelectorAll('[data-original-text]').forEach(target => {
                const translated = target.dataset.lastTranslatedText;
                const bilingual = target.dataset.lastBilingualText;
                if (!translated) return;
                target.innerText = bilingualMode ? bilingual : translated;
            });
        }
    }
    if (changes.targetLang) {
        targetLang = changes.targetLang.newValue;
        settingsChanged = true;
        
        // Re-translate all existing cues and DOM nodes to the new language
        if (pluginEnabled) {
            translatedCues.forEach(item => {
                const origText = item.original;
                item.cue.isTranslating = true;
                translateText(origText, (newTranslated) => {
                    item.translated = newTranslated;
                    try {
                        item.cue.text = bilingualMode ? `${newTranslated}\n${origText}` : newTranslated;
                    } catch(e) {}
                    item.cue.isTranslating = false;
                });
            });
            
            document.querySelectorAll('[data-original-text]').forEach(target => {
                const orig = target.dataset.originalText;
                if (!orig) return;
                target.style.opacity = "0";
                translateText(orig, (newTranslated) => {
                    target.dataset.lastTranslatedText = newTranslated;
                    const bilingual = `${newTranslated}\n${orig}`;
                    target.dataset.lastBilingualText = bilingual;
                    target.innerText = bilingualMode ? bilingual : newTranslated;
                    target.style.opacity = "1";
                });
            });
        }
    }
    if (settingsChanged) {
        window.postMessage({ type: 'SUBTITLE_TRANSLATOR_SETTINGS', pluginEnabled, bilingualMode, targetLang }, '*');
    }
});

// Periodically sync settings to MAIN world (intercept.js can only receive via postMessage)
// Uses change detection to avoid redundant broadcasts
let lastBroadcast = '';
setInterval(() => {
    chrome.storage.sync.get({ pluginEnabled: true, bilingualMode: false, targetLang: 'zh-CN' }, (data) => {
        const key = `${data.pluginEnabled}:${data.bilingualMode}:${data.targetLang}`;
        if (key !== lastBroadcast) {
            lastBroadcast = key;
            pluginEnabled = data.pluginEnabled;
            bilingualMode = data.bilingualMode;
            targetLang = data.targetLang;
            window.postMessage({ type: 'SUBTITLE_TRANSLATOR_SETTINGS', pluginEnabled, bilingualMode, targetLang }, '*');
            console.log('[ST] Settings synced:', data);
        }
    });
}, 3000);

// ========== Translation via background worker ==========
function translateText(text, callback) {
    chrome.runtime.sendMessage({ action: 'translate', text: text }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("[Subtitle Translator] Runtime error:", chrome.runtime.lastError);
            callback(text);
            return;
        }
        if (response && response.success) {
            callback(response.translation);
        } else {
            callback(text);
        }
    });
}

// =============================================
// YOUTUBE: Bridge between main world intercept.js and background worker
// =============================================
const isYouTube = window.location.hostname.includes('youtube.com');

if (isYouTube) {
    console.log("[Subtitle Translator] YouTube mode: bridging intercept.js <-> background.js");
    
    // Listen for translation requests from main world intercept.js
    window.addEventListener('message', (event) => {
        if (!event.data) return;
        
        // Single text translation (legacy, still used as fallback)
        if (event.data.type === 'SUBTITLE_TRANSLATOR_REQUEST') {
            const { id, text } = event.data;
            translateText(text, (translated) => {
                window.postMessage({
                    type: 'SUBTITLE_TRANSLATOR_RESULT',
                    id, translated, original: text
                }, '*');
            });
        }
        
        // Download subtitle track JSON (legacy - kept for compatibility)
        if (event.data.type === 'SUBTITLE_TRACK_REQUEST') {
            const { url } = event.data;
            chrome.runtime.sendMessage({ action: 'fetchUrl', url }, (response) => {
                if (chrome.runtime.lastError) {
                    window.postMessage({ type: 'SUBTITLE_TRACK_RESULT', error: chrome.runtime.lastError.message }, '*');
                    return;
                }
                if (response && response.success) {
                    try {
                        const json = JSON.parse(response.data);
                        window.postMessage({ type: 'SUBTITLE_TRACK_RESULT', events: json.events || [] }, '*');
                    } catch(e) {
                        window.postMessage({ type: 'SUBTITLE_TRACK_RESULT', error: 'Parse error: ' + e.message }, '*');
                    }
                } else {
                    window.postMessage({ type: 'SUBTITLE_TRACK_RESULT', error: response?.error || 'Fetch failed' }, '*');
                }
            });
        }
        
        // Batch translate
        if (event.data.type === 'SUBTITLE_BATCH_REQUEST') {
            const { texts, batchIndex } = event.data;
            chrome.runtime.sendMessage({ action: 'translateBatch', texts }, (response) => {
                if (chrome.runtime.lastError) {
                    window.postMessage({ type: 'SUBTITLE_BATCH_RESULT', error: chrome.runtime.lastError.message, batchIndex }, '*');
                    return;
                }
                if (response && response.success) {
                    window.postMessage({ type: 'SUBTITLE_BATCH_RESULT', translations: response.translations, batchIndex }, '*');
                } else {
                    window.postMessage({ type: 'SUBTITLE_BATCH_RESULT', error: response?.error || 'Translation failed', batchIndex }, '*');
                }
            });
        }
    });
    
    // #7: Settings are sent on init (line 7) and on change (line 12) — no polling needed
} else {
    console.log("[Subtitle Translator] Non-YouTube mode: DOM observation.");
    initDOMObservation();
}

// =============================================
// DOM Observation (HTML5 Custom Players etc.)
// =============================================

function initDOMObservation() {
    findVideos();
    // Replaced heavy MutationObserver on body with a simple periodic check
    // This reduces CPU usage considerably for dynamic SPAs.
    setInterval(findVideos, 2000);
}

function setupTrackListening(video) {
    if (video.dataset.translatorHooked) return;
    video.dataset.translatorHooked = "true";
    
    // #8: Poll for tracks (needed for lazy-loaded players)
    // but auto-stop after 30 seconds to prevent infinite polling
    const startTime = Date.now();
    const interval = setInterval(() => {
        // Stop polling after 30 seconds
        if (Date.now() - startTime > 30000) {
            clearInterval(interval);
            return;
        }
        let allDone = true;
        Array.from(video.textTracks).forEach(track => {
            if (track.translationHooked) return;
            track.translationHooked = true;
            allDone = false;
            const processCues = () => {
                if (!track.cues) return;
                Array.from(track.cues).forEach(cue => {
                    if (!cue.text || cue.isTranslating || cue.translated) return;
                    // Skip new translations if plugin is disabled
                    if (!pluginEnabled) return;

                    cue.isTranslating = true;
                    const origText = cue.text;
                    translateText(origText, (translated) => {
                        if (!cue.translated) {
                            cue.text = bilingualMode ? `${translated}\n${origText}` : translated;
                            cue.translated = true;
                            // Track for re-formatting on bilingualMode change
                            addTranslatedCue({ cue, original: origText, translated });
                        }
                    });
                });
            };
            processCues();
            track.addEventListener('cuechange', processCues);
        });
        // If all tracks are already hooked, we can stop early
        if (video.textTracks.length > 0 && allDone) {
            clearInterval(interval);
        }
    }, 1000);

    // Watch the individual video player container for DOM subtiles instead of global body
    const playerContainer = video.closest('.video-js, .shaka-video-container, .player-wrapper') || video.parentElement;
    if (playerContainer) {
        startDOMObserver(playerContainer);
    }
}

function findVideos() {
    document.querySelectorAll('video').forEach(setupTrackListening);
}

function startDOMObserver(container) {
    if (container.dataset.domObserverHooks) return;
    container.dataset.domObserverHooks = "true";

    const selectors = '.vjs-text-track-cue-display, .vjs-text-track-cue, .shaka-text-wrapper > div';

    const process = (target) => {
        const text = target.innerText || target.textContent;
        // Skip if empty or we are disabled
        if (!text || !text.trim()) return;
        if (!pluginEnabled) return;
        
        // Robust skip: prevent infinite loop by checking if this text is the one we injected
        if (text === target.dataset.lastBilingualText || text === target.dataset.lastTranslatedText) return;
        
        const origText = text;
        target.dataset.originalText = origText;
        target.style.opacity = "0";

        translateText(origText, (translated) => {
            target.dataset.lastTranslatedText = translated;
            const bilingual = `${translated}\n${origText}`;
            target.dataset.lastBilingualText = bilingual;
            
            target.innerText = bilingualMode ? bilingual : translated;
            target.style.opacity = "1";
        });
    };

    new MutationObserver(mutations => {
        mutations.forEach(m => {
            if (m.type === 'childList') {
                m.addedNodes.forEach(n => {
                    if (n.nodeType === 1) {
                        if (n.matches && n.matches(selectors)) process(n);
                        if (n.querySelectorAll) {
                            try { n.querySelectorAll(selectors).forEach(process); } catch(e) {}
                        }
                    }
                });
            } else if (m.type === 'characterData') {
                const parent = m.target.parentElement;
                if (parent && parent.matches && parent.matches(selectors)) process(parent);
            }
        });
    }).observe(container, { childList: true, subtree: true, characterData: true });
}
