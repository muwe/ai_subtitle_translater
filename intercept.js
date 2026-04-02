// intercept.js - MAIN world (YouTube only, document_start)
// INTERCEPT MODE: Hooks YouTube's own timedtext XHR/fetch to grab subtitle JSON directly.
// Falls back to DOM observer if interception misses.
(function() {
    'use strict';
    
    // ===== Hook YouTube's own timedtext requests (most reliable method) =====
    // YouTube's player fetches subtitles itself with full auth cookies.
    // We intercept that response directly instead of re-fetching.
    let interceptedHandler = null;  // Set later once parseSubtitleEvents is defined
    
    const _origFetch = window.fetch;
    window.fetch = function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        const p = _origFetch.apply(this, args);
        if (url.includes('timedtext')) {
            p.then(r => r.clone().text()).then(text => {
                if (text && text.length > 100 && interceptedHandler) {
                    try { interceptedHandler(JSON.parse(text)); } catch(e) {}
                }
            }).catch(() => {});
        }
        return p;
    };
    
    const _origOpen = XMLHttpRequest.prototype.open;
    const _origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._stUrl = url || '';
        return _origOpen.apply(this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function(...args) {
        if (this._stUrl.includes('timedtext')) {
            this.addEventListener('load', () => {
                if (this.responseText && this.responseText.length > 100 && interceptedHandler) {
                    try {
                        const json = JSON.parse(this.responseText);
                        if (json.events) interceptedHandler(json);
                    } catch(e) {}
                }
            });
        }
        return _origSend.apply(this, args);
    };
    
    let pluginEnabled = true;
    let bilingualMode = false;
    let targetLang = 'zh-CN';
    const BASE_STYLE = 'background:rgba(8,8,8,0.75);padding:6px 14px;border-radius:4px;display:inline-block;max-width:90%;line-height:1.4;font-family:"YouTube Noto",Roboto,Arial,Helvetica,sans-serif';
    let subtitles = [];       // [{start, end, text, zh}]
    let currentSubIndex = -1;
    let overlay = null;
    let isLoading = false;
    let lastVideoId = '';
    
    // ===== DOM Fallback Variables =====
    let isFallbackMode = false;
    let observer = null;
    let emptyWatcher = null;
    let sentenceBuffer = '';
    let bufferStartTime = 0;
    let lastYoutubeText = '';
    let flushTimer = null;
    let translatorIdCounter = 0;
    const pendingTranslations = new Map();
    const MAX_SENTENCE_MS = 3000;
    const MIN_DISPLAY_MS = 1200;
    const EMPTY_HIDE_MS = 3000;
    
    // Listen for messages from content script
    window.addEventListener('message', (e) => {
        if (!e.data) return;
        
        if (e.data.type === 'SUBTITLE_TRANSLATOR_SETTINGS') {
            const oldBilingual = bilingualMode;
            const oldPluginEnabled = pluginEnabled;
            
            if (e.data.pluginEnabled !== undefined) {
                pluginEnabled = e.data.pluginEnabled;
            }
            bilingualMode = e.data.bilingualMode;
            
            // Handle language change — clear translations and re-translate
            if (e.data.targetLang && e.data.targetLang !== targetLang) {
                targetLang = e.data.targetLang;
                console.log('[ST] Target language changed to:', targetLang);
                // Clear all existing translations
                subtitles.forEach(s => { s.zh = null; });
                currentSubIndex = -1;
                // Re-request batch translation with new language
                if (subtitles.length > 0) {
                    requestBatchTranslation();
                    syncDisplay(); // Immediately clear old translation from screen
                }
            }
            
            // Handle bilingual mode or enable state change
            if (bilingualMode !== oldBilingual || pluginEnabled !== oldPluginEnabled) {
                currentSubIndex = -1;  // Force re-render
                syncDisplay();
            }
        }
        
        // Handle fallback translations
        if (e.data.type === 'SUBTITLE_TRANSLATOR_RESULT') {
            if (!isFallbackMode) return;
            const { id, translated, original } = e.data;
            if (pendingTranslations.has(id)) {
                const cb = pendingTranslations.get(id);
                pendingTranslations.delete(id);
                cb(translated, original);
            }
        }
        
        
        // Receive batch translation results
        if (e.data.type === 'SUBTITLE_BATCH_RESULT') {
            const { translations, batchIndex, error } = e.data;
            if (error) {
                console.warn('[ST] Batch translation error:', error);
                return;
            }
            applyBatchTranslation(translations, batchIndex);
        }
    });

    // ===== Subtitle parsing =====
    // Since we have ALL events pre-fetched, we use a batch-first approach:
    // Step 1: Find the FINAL (longest/most complete) text in each ASR growing group.
    // Step 2: Merge those finals into natural display paragraphs by time gaps.
    // Result: each subtitle entry is a complete unit, displayed once, no flickering.
    function parseSubtitleEvents(events) {
        subtitles = [];
        if (!events || events.length === 0) return;
        
        events.sort((a, b) => a.tStartMs - b.tStartMs);
        
        // Step 1: Identify the FINAL text of each ASR growing group.
        // YouTube ASR emits: "Hello" → "Hello how" → "Hello how are you" (same group)
        // Then: "doing" → "doing today" (new group)
        // The FINAL of each group is the event where the NEXT event does NOT continue growing.
        const finals = [];
        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            if (!ev.segs) continue;
            const text = cleanText(ev.segs.map(s => s.utf8 || '').join(''));
            if (!text || text.length < 2) continue;
            
            const nextEv = events[i + 1];
            const nextText = (nextEv && nextEv.segs)
                ? cleanText(nextEv.segs.map(s => s.utf8 || '').join(''))
                : '';
            
            // Growing: next event is a longer version of this one
            const isGrowing = nextText && (
                nextText.startsWith(text.substring(0, Math.min(text.length, 15))) ||
                text.startsWith(nextText.substring(0, Math.min(nextText.length, 15)))
            );
            
            if (!isGrowing) {
                // This event is the final, complete text of this ASR breath group
                finals.push({
                    text,
                    start: ev.tStartMs,
                    end: ev.tStartMs + (ev.dDurationMs || 3000)
                });
            }
        }
        
        // Step 2: Merge finals into natural display paragraphs.
        // A paragraph flushes when: sentence ends with punctuation, word count >= 20, or gap > 1.5s
        let paraText = '';
        let paraStart = -1;
        let prevEnd = 0;
        
        for (let i = 0; i < finals.length; i++) {
            const f = finals[i];
            
            if (paraStart === -1) paraStart = f.start;
            
            // Gap detected (> 1s silence) → flush and start new block
            if (paraText && f.start - prevEnd > 1000) {
                const nextStart = f.start;
                subtitles.push({ start: paraStart, end: nextStart, text: paraText.trim(), zh: null });
                paraText = '';
                paraStart = f.start;
            }
            
            if (paraText) paraText += ' ';
            paraText += f.text;
            prevEnd = f.end;
            
            // Flush conditions (earlier = shorter subtitles):
            // 1. This final itself ends with sentence punctuation → natural sentence end
            // 2. Total accumulated words reached limit (8 words ≈ one comfortable display line)
            const wordCount = paraText.split(/\s+/).length;
            const thisFinalsEnds = isSentenceEnd(f.text);
            if (thisFinalsEnds || wordCount >= 8) {
                const nextStart = finals[i + 1] ? finals[i + 1].start : prevEnd;
                subtitles.push({ start: paraStart, end: nextStart, text: paraText.trim(), zh: null });
                paraText = '';
                paraStart = -1;
            }
        }
        
        // Flush any remaining text
        if (paraText) {
            subtitles.push({ start: paraStart, end: prevEnd, text: paraText.trim(), zh: null });
        }
        
        // Safety: ensure no overlapping start/end for binary search
        for (let i = 0; i < subtitles.length - 1; i++) {
            if (subtitles[i].end > subtitles[i + 1].start) {
                subtitles[i].end = subtitles[i + 1].start;
            }
        }
        
        console.log(`[ST] ${events.length} raw events → ${finals.length} finals → ${subtitles.length} display paragraphs`);
    }

    // ===== Batch translation =====
    const BATCH_SIZE = 10;
    let totalBatches = 0;
    let completedBatches = 0;
    
    function requestBatchTranslation() {
        if (subtitles.length === 0) {
            isLoading = false;
            return;
        }
        
        // Split into batches — use large batches + slow spacing to avoid Google rate limits
        const allTexts = subtitles.map(s => s.text);
        totalBatches = Math.ceil(allTexts.length / BATCH_SIZE);
        completedBatches = 0;
        
        console.log('[ST] Requesting translation:', allTexts.length, 'texts in', totalBatches, 'batches');
        
        for (let i = 0; i < totalBatches; i++) {
            const batch = allTexts.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
            setTimeout(() => {
                window.postMessage({
                    type: 'SUBTITLE_BATCH_REQUEST',
                    texts: batch,
                    batchIndex: i
                }, '*');
            }, i * 2000);  // 2 seconds between batches to avoid rate limiting
        }
    }
    
    function applyBatchTranslation(translations, batchIndex) {
        const startIdx = batchIndex * BATCH_SIZE;
        for (let i = 0; i < translations.length; i++) {
            const idx = startIdx + i;
            if (idx < subtitles.length) {
                subtitles[idx].zh = translations[i];
            }
        }
        completedBatches++;
        console.log('[ST] Batch', batchIndex, 'done (' + completedBatches + '/' + totalBatches + ')');
        
        // Force sync immediately so paused videos update as soon as their text arrives
        syncDisplay();
        
        if (completedBatches >= totalBatches) {
            isLoading = false;
            console.log('[ST] ✅ All translations complete!');
            currentSubIndex = -1;
            syncDisplay();
        }
    }

    // ===== Rendering =====
    function getOrCreateOverlay() {
        if (overlay && overlay.isConnected) return overlay;
        const player = document.getElementById('movie_player');
        if (!player) return null;
        overlay = document.createElement('div');
        overlay.id = 'st-subtitle-overlay';
        overlay.style.cssText = [
            'position:absolute','bottom:70px','left:0','right:0',
            'text-align:center','z-index:99','pointer-events:none',
            'padding:0 3%','display:flex','flex-direction:column',
            'align-items:center','gap:4px'
        ].join(';');
        player.appendChild(overlay);
        return overlay;
    }
    
    function renderLines(enText, zhText) {
        const el = getOrCreateOverlay();
        if (!el) return;
        while (el.firstChild) el.removeChild(el.firstChild);
        
        const baseStyle = BASE_STYLE;
        
        if (bilingualMode && enText) {
            const enSpan = document.createElement('span');
            enSpan.style.cssText = baseStyle + ';color:#fff;font-size:2.2rem;';
            enSpan.appendChild(document.createTextNode(enText));
            el.appendChild(enSpan);
        }
        
        const displayText = zhText || enText;  // Show English if translation not ready yet
        if (displayText) {
            const zhSpan = document.createElement('span');
            zhSpan.style.cssText = baseStyle + ';color:#fff;font-size:2.4rem;font-weight:500;';
            zhSpan.appendChild(document.createTextNode(displayText));
            el.appendChild(zhSpan);
        }
        
        el.style.opacity = '1';
        hideOriginalCaptions();
    }
    
    function hideSubtitle() {
        if (overlay && overlay.isConnected) {
            while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
            overlay.style.opacity = '0';
        }
        currentSubIndex = -1;
    }
    
    function hideOriginalCaptions() {
        const c = document.getElementById('ytp-caption-window-container');
        if (c) c.querySelectorAll('.caption-window').forEach(w => { w.style.opacity = '0'; });
    }

    // ===== Sync display with video time =====
    function syncDisplay() {
        if (!pluginEnabled) {
            hideSubtitle();
            return;
        }

        const video = document.querySelector('video');
        if (!video || subtitles.length === 0) return;
        
        const ms = video.currentTime * 1000;
        
        // Binary search for current subtitle
        let found = -1;
        let lo = 0, hi = subtitles.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (ms >= subtitles[mid].start && ms < subtitles[mid].end) {
                found = mid;
                break;
            } else if (ms < subtitles[mid].start) {
                hi = mid - 1;
            } else {
                lo = mid + 1;
            }
        }
        
        if (found >= 0) {
            const s = subtitles[found];
            // Re-render if index changed OR if zh just became available
            if (found !== currentSubIndex || (s.zh && currentSubIndex === found && overlay && !overlay.textContent.includes(s.zh))) {
                currentSubIndex = found;
                renderLines(s.text, s.zh);
            }
        } else {
            if (currentSubIndex >= 0) {
                hideSubtitle();
            }
        }
    }
    
    // ===== Video monitoring =====
    let videoSyncActive = false;
    
    function startVideoSync() {
        if (videoSyncActive) return;  // #1: Prevent duplicate listeners
        const video = document.querySelector('video');
        if (!video) return;
        
        video.addEventListener('timeupdate', syncDisplay);
        video.addEventListener('seeked', syncDisplay);
        videoSyncActive = true;
        console.log('[ST] Video sync started');
    }
    
    function stopVideoSync() {
        const video = document.querySelector('video');
        if (video) {
            video.removeEventListener('timeupdate', syncDisplay);
            video.removeEventListener('seeked', syncDisplay);
        }
        videoSyncActive = false;
    }

    // ===== Extract subtitle track URL =====
    function getSubtitleTrackUrl() {
        // Strategy 1: ytInitialPlayerResponse global variable
        try {
            const pr = window.ytInitialPlayerResponse;
            if (pr) {
                const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                if (tracks && tracks.length > 0) {
                    let track = tracks.find(t => t.languageCode === 'en');
                    if (!track) track = tracks.find(t => t.languageCode?.startsWith('en'));
                    if (!track) track = tracks[0];
                    
                    let url = track.baseUrl;
                    if (!url.includes('fmt=')) url += '&fmt=json3';
                    else url = url.replace(/fmt=\w+/, 'fmt=json3');
                    
                    console.log('[ST] Strategy 1: Found track via ytInitialPlayerResponse:', track.languageCode);
                    return url;
                }
            }
        } catch(e) { console.warn('[ST] Strategy 1 failed:', e.message); }
        
        // Strategy 2: ytplayer.config (sometimes available)
        try {
            if (window.ytplayer?.config?.args?.raw_player_response) {
                const pr = window.ytplayer.config.args.raw_player_response;
                const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                if (tracks && tracks.length > 0) {
                    let track = tracks.find(t => t.languageCode === 'en') || tracks[0];
                    let url = track.baseUrl;
                    if (!url.includes('fmt=')) url += '&fmt=json3';
                    console.log('[ST] Strategy 2: Found track via ytplayer.config:', track.languageCode);
                    return url;
                }
            }
        } catch(e) { console.warn('[ST] Strategy 2 failed:', e.message); }
        
        // Strategy 3 removed: full-page HTML scan was too expensive (3-5MB string copy)
        
        return null;
    }
    
    function getVideoId() {
        const match = window.location.href.match(/[?&]v=([^&]+)/);
        return match ? match[1] : '';
    }

    // ===== Initialize for current video =====
    let retryCount = 0;
    const MAX_RETRIES = 10;
    
    function handleInterceptedSubtitles(json) {
        // Called when we successfully intercept YouTube's own timedtext request
        const events = json.events || [];
        if (events.length === 0) return;
        if (subtitles.length > 0) return;  // Already have data
        
        console.log('[ST] ✅ Intercepted YouTube timedtext! Events:', events.length);
        stopFallbackMode();
        isLoading = true;
        lastVideoId = getVideoId();
        startVideoSync();
        parseSubtitleEvents(events);
        requestBatchTranslation();
    }
    
    function initForVideo() {
        const videoId = getVideoId();
        if (!videoId) return;
        if (videoId === lastVideoId && (subtitles.length > 0 || isFallbackMode)) return;
        
        console.log('[ST] Initializing for video:', videoId, '(attempt', retryCount + 1 + ')');
        
        // Register interception handler for this video
        interceptedHandler = handleInterceptedSubtitles;
        
        const url = getSubtitleTrackUrl();
        if (url) {
            stopFallbackMode();
            lastVideoId = videoId;
            subtitles = [];
            currentSubIndex = -1;
            isLoading = true;
            retryCount = 0;
            
            // Try fetching directly (works if cookies are present)
            // Also try srv3 format (what YouTube's player actually uses)
            const urlJson3 = url.includes('fmt=') ? url.replace(/fmt=\w+/, 'fmt=json3') : url + '&fmt=json3';
            const urlSrv3  = url.includes('fmt=') ? url.replace(/fmt=\w+/, 'fmt=srv3')  : url + '&fmt=srv3';
            
            console.log('[ST] Attempting direct fetch (json3 then srv3)...');
            
            // Try json3 first, then srv3 as fallback
            const tryFetch = (fetchUrl, label) => fetch(fetchUrl)
                .then(r => r.text())
                .then(text => {
                    if (!text || text.length < 50) throw new Error('empty');
                    const json = JSON.parse(text);
                    const events = json.events || [];
                    if (events.length === 0) throw new Error('no events');
                    console.log(`[ST] Direct fetch (${label}) succeeded: ${events.length} events`);
                    startVideoSync();  // #2: Ensure video sync is active
                    parseSubtitleEvents(events);
                    requestBatchTranslation();
                });
            
            tryFetch(urlJson3, 'json3')
                .catch(() => tryFetch(urlSrv3, 'srv3'))
                .catch(() => {
                    console.warn('[ST] Direct fetch failed. Waiting for interception or DOM fallback...');
                    isLoading = false;
                    // Give the XHR interception 5 seconds to catch YouTube's own request
                    setTimeout(() => {
                        if (subtitles.length === 0 && !isFallbackMode) {
                            console.log('[ST] Interception timed out, starting DOM fallback.');
                            startFallbackMode();
                        }
                    }, 5000);
                });
        } else {
            retryCount++;
            if (retryCount <= MAX_RETRIES) {
                console.log('[ST] No subtitle track found, retry', retryCount, '/', MAX_RETRIES, 'in 2s...');
                setTimeout(initForVideo, 2000);
            } else {
                console.warn('[ST] Gave up finding subtitles after', MAX_RETRIES, 'retries. Falling back to DOM mode.');
                retryCount = 0;
                isLoading = false;
                startFallbackMode();
            }
        }
    }
    
    // ==========================================
    // DOM FALLBACK MODE (When Pre-fetch fails)
    // ==========================================
    function startFallbackMode() {
        if (isFallbackMode) return;
        console.log('[ST] Starting DOM Fallback Mode...');
        isFallbackMode = true;
        subtitles = [];
        
        stopVideoSync();
        
        startObserver();
        startEmptyWatcher();
    }
    
    function stopFallbackMode() {
        isFallbackMode = false;
        if (observer) { observer.disconnect(); observer = null; }
        if (emptyWatcher) { clearInterval(emptyWatcher); emptyWatcher = null; }
        sentenceBuffer = '';
        lastYoutubeText = '';
    }

    function isSentenceEnd(text) { return /[.!?;]\s*$/.test(text); }
    // isLongEnough removed: replaced by inline wordCount checks
    function cleanText(text) { return text.replace(/\s*>>\s*/g, ' ').replace(/\s+/g, ' ').trim(); }
    
    function collectCurrentText() {
        const segments = document.querySelectorAll('.ytp-caption-segment');
        if (segments.length === 0) return '';
        return Array.from(segments).map(s => s.innerText || s.textContent || '').join('');
    }

    function rebuildBuffer(buffer, oldText, newText) {
        if (!buffer || !oldText) return newText;
        if (buffer.endsWith(oldText)) return buffer.slice(0, -oldText.length) + newText;
        if (newText.startsWith(oldText)) return buffer + newText.substring(oldText.length);
        const overlap = findOverlap(buffer, newText);
        if (overlap > 0) return buffer + newText.substring(overlap);
        return buffer + ' ' + newText;
    }

    function findOverlap(a, b) {
        // #5: Limit search window to last 50 chars to avoid O(n²) on long texts
        const maxSearch = Math.min(50, a.length, b.length);
        const aTail = a.substring(a.length - maxSearch);
        for (let i = maxSearch; i > 0; i--) {
            if (aTail.endsWith(b.substring(0, i))) return i;
        }
        return 0;
    }

    // Show English text IMMEDIATELY in overlay, then async translate to Chinese
    function showEnglishNow(text) {
        const el = getOrCreateOverlay();
        if (!el) return;
        while (el.firstChild) el.removeChild(el.firstChild);
        const baseStyle = BASE_STYLE;
        const span = document.createElement('span');
        span.style.cssText = baseStyle + ';color:#fff;font-size:2.2rem;';
        span.appendChild(document.createTextNode(text));
        el.appendChild(span);
        el.style.opacity = '1';
        hideOriginalCaptions();
    }

    function flushSentence() {
        const textToTranslate = sentenceBuffer;
        sentenceBuffer = '';
        lastYoutubeText = '';
        bufferStartTime = 0;
        
        if (!textToTranslate.trim()) return;
        
        // Show English immediately while waiting for translation
        showEnglishNow(textToTranslate);
        
        const id = ++translatorIdCounter;
        pendingTranslations.set(id, (translated, original) => {
            // Chinese arrives ~300ms later: update overlay to bilingual
            renderLines(original, translated);
        });
        
        window.postMessage({
            type: 'SUBTITLE_TRANSLATOR_REQUEST',
            id: id,
            text: textToTranslate
        }, '*');
    }

    function startEmptyWatcher() {
        if (emptyWatcher) clearInterval(emptyWatcher);
        let nothingCounter = 0;
        emptyWatcher = setInterval(() => {
            if (!document.querySelector('.ytp-caption-segment')) {
                nothingCounter += 500;
                if (nothingCounter >= EMPTY_HIDE_MS) {
                    if (sentenceBuffer) flushSentence();
                    else hideSubtitle();
                }
            } else {
                nothingCounter = 0;
            }
        }, 500);
    }

    function startObserver() {
        const container = document.getElementById('ytp-caption-window-container');
        if (!container) {
            setTimeout(startObserver, 1000);
            return;
        }
        
        if (observer) observer.disconnect();
        
        let updateTimer = null;
        let stableTimer = null;   // fires when text stops changing = sentence complete
        
        observer = new MutationObserver(() => {
            if (updateTimer) clearTimeout(updateTimer);
            updateTimer = setTimeout(() => {
                const rawText = collectCurrentText();
                
                // Text cleared → flush remaining buffer
                if (!rawText || rawText.length < 2) {
                    if (stableTimer) clearTimeout(stableTimer);
                    stableTimer = setTimeout(() => {
                        stableTimer = null;
                        if (sentenceBuffer) flushSentence();
                        lastYoutubeText = '';
                    }, 200);
                    return;
                }
                
                if (/[\u4e00-\u9fa5]/.test(rawText)) return;  // Skip if showing Chinese
                if (rawText === lastYoutubeText) return;       // No change, skip
                
                hideOriginalCaptions();
                
                const currentText = cleanText(rawText);
                if (!currentText || currentText.length < 2) return;
                
                const prevClean = cleanText(lastYoutubeText);
                
                // Detect YouTube's sliding window behavior:
                // 1. Forward-growing:  "Hello how" → "Hello how are"
                // 2. Sliding window:   "Hello how are" → "how are you"  (dropped "Hello")
                // Both should be treated as "still the same utterance", not a new sentence.
                const overlapLen = findOverlap(prevClean, currentText);
                const isForwardGrow = lastYoutubeText && currentText.startsWith(prevClean.substring(0, Math.min(prevClean.length, 15)));
                const isSlidingWindow = overlapLen > 5;  // Old tail overlaps with new head
                const isGrowing = isForwardGrow || isSlidingWindow;
                
                // Accumulate into buffer
                if (isGrowing) {
                    // Growing or sliding: extend the buffer without repeating
                    sentenceBuffer = rebuildBuffer(sentenceBuffer, prevClean, currentText);
                } else {
                    // Genuinely new utterance
                    if (sentenceBuffer) sentenceBuffer += ' ' + currentText;
                    else sentenceBuffer = currentText;
                    if (!bufferStartTime) bufferStartTime = Date.now();
                }
                
                lastYoutubeText = rawText;
                
                // Clear pending stable timer since text is still changing
                if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
                
                // Only flush at natural non-growing boundaries
                if (!isGrowing && sentenceBuffer) {
                    const wordCount = sentenceBuffer.split(/\s+/).length;
                    const elapsed = Date.now() - (bufferStartTime || Date.now());
                    
                    if (isSentenceEnd(sentenceBuffer) || wordCount >= 10 || elapsed >= MAX_SENTENCE_MS) {
                        flushSentence();
                    } else {
                        // Flush 400ms after text stops changing (sentence spoken, brief pause)
                        stableTimer = setTimeout(() => {
                            stableTimer = null;
                            if (sentenceBuffer) flushSentence();
                        }, 400);
                    }
                } else if (isGrowing) {
                    // While growing, set a safety flush in case it never stops
                    stableTimer = setTimeout(() => {
                        stableTimer = null;
                        if (sentenceBuffer) flushSentence();
                    }, MAX_SENTENCE_MS);
                }
            }, 80);  // 80ms debounce
        });
        
        observer.observe(container, { childList: true, subtree: true, characterData: true });
    }

    // ===== Watch for YouTube SPA navigation =====
    function cleanupForNewVideo() {
        stopVideoSync();
        stopFallbackMode();
        hideSubtitle();
        subtitles = [];
        currentSubIndex = -1;
        isLoading = false;
        lastVideoId = '';
        retryCount = 0;
        videoSyncActive = false;
    }
    
    function watchNavigation() {
        let lastUrl = window.location.href;
        
        const checkUrl = () => {
            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;
                if (lastUrl.includes('/watch')) {
                    cleanupForNewVideo();
                    setTimeout(initForVideo, 1500);
                }
            }
        };
        
        setInterval(checkUrl, 1000);
        window.addEventListener('popstate', () => setTimeout(checkUrl, 500));
    }
    
    // ===== Startup =====
    function startup() {
        // Wait for page to load enough
        const tryInit = () => {
            if (document.querySelector('video')) {
                startVideoSync();
                initForVideo();
            } else {
                setTimeout(tryInit, 1000);
            }
        };
        
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            setTimeout(tryInit, 1000);
        } else {
            document.addEventListener('DOMContentLoaded', () => setTimeout(tryInit, 1000));
        }
        
        watchNavigation();
    }
    
    startup();
    console.log('[ST] Pre-fetch subtitle translator loaded.');
})();
