// background.js - Service Worker
// Multi-provider translation with automatic fallback + multi-language support

// ===== Translation Cache =====
const translationCache = new Map();
const MAX_CACHE_SIZE = 2000;

function getCached(text, lang) {
  return translationCache.get(`${lang}:${text}`);
}

function setCache(text, lang, translation) {
  const key = `${lang}:${text}`;
  if (translationCache.size >= MAX_CACHE_SIZE) {
    const firstKey = translationCache.keys().next().value;
    translationCache.delete(firstKey);
  }
  translationCache.set(key, translation);
}

// ===== Target Language =====
let targetLang = 'zh-CN';

// Language code mapping for different provider formats
function getLangCodes(lang) {
  // Map our standard codes to each provider's format
  const bingMap = {
    'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant',
    'ja': 'ja', 'ko': 'ko', 'es': 'es', 'fr': 'fr', 'de': 'de',
    'pt': 'pt', 'ru': 'ru', 'ar': 'ar', 'hi': 'hi', 'th': 'th',
    'vi': 'vi', 'id': 'id', 'it': 'it', 'tr': 'tr'
  };
  const myMemoryMap = {
    'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW',
    'ja': 'ja', 'ko': 'ko', 'es': 'es', 'fr': 'fr', 'de': 'de',
    'pt': 'pt', 'ru': 'ru', 'ar': 'ar', 'hi': 'hi', 'th': 'th',
    'vi': 'vi', 'id': 'id', 'it': 'it', 'tr': 'tr'
  };
  const lingvaMap = {
    'zh-CN': 'zh', 'zh-TW': 'zh_HANT',
    'ja': 'ja', 'ko': 'ko', 'es': 'es', 'fr': 'fr', 'de': 'de',
    'pt': 'pt', 'ru': 'ru', 'ar': 'ar', 'hi': 'hi', 'th': 'th',
    'vi': 'vi', 'id': 'id', 'it': 'it', 'tr': 'tr'
  };
  return {
    google: lang,
    bing: bingMap[lang] || lang,
    myMemory: myMemoryMap[lang] || lang,
    lingva: lingvaMap[lang] || lang
  };
}

// ===== Translation Providers =====

// Provider 1: Google Translate
async function googleTranslate(text) {
  const codes = getLangCodes(targetLang);
  const encoded = encodeURIComponent(text);
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${codes.google}&dt=t&q=${encoded}`;
  const response = await fetch(url);
  const ct = response.headers.get('content-type') || '';
  if (ct.includes('text/html')) throw new Error('Google rate limited');
  const data = await response.json();
  let result = '';
  if (data && data[0]) {
    data[0].forEach(seg => { if (seg[0]) result += seg[0]; });
  }
  if (!result) throw new Error('Empty Google response');
  return result;
}

// Provider 2: Microsoft/Bing Translate
let bingToken = null;
let bingTokenExpiry = 0;

async function getBingToken() {
  if (bingToken && Date.now() < bingTokenExpiry) return bingToken;
  const response = await fetch('https://edge.microsoft.com/translate/auth');
  if (!response.ok) throw new Error('Bing auth failed');
  bingToken = await response.text();
  bingTokenExpiry = Date.now() + 8 * 60 * 1000;
  return bingToken;
}

async function bingTranslate(text) {
  const codes = getLangCodes(targetLang);
  const token = await getBingToken();
  const response = await fetch(
    `https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=${codes.bing}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([{ Text: text }])
    }
  );
  if (!response.ok) {
    bingToken = null;
    throw new Error(`Bing HTTP ${response.status}`);
  }
  const data = await response.json();
  if (data && data[0] && data[0].translations && data[0].translations[0]) {
    return data[0].translations[0].text;
  }
  throw new Error('Invalid Bing response');
}

// Provider 3: MyMemory API
async function myMemoryTranslate(text) {
  const codes = getLangCodes(targetLang);
  const encoded = encodeURIComponent(text);
  const url = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=en|${codes.myMemory}`;
  const response = await fetch(url);
  const data = await response.json();
  if (data && data.responseData && data.responseData.translatedText) {
    const translated = data.responseData.translatedText;
    if (translated.includes('MYMEMORY WARNING') || translated.includes('PLEASE NOTE')) {
      throw new Error('MyMemory quota exceeded');
    }
    return translated;
  }
  throw new Error('Invalid MyMemory response');
}

// Provider 4: Lingva Translate
const LINGVA_INSTANCES = ['lingva.ml', 'lingva.pussthecat.org', 'translate.plausibility.cloud'];
let lingvaIndex = 0;

async function lingvaTranslate(text) {
  const codes = getLangCodes(targetLang);
  const encoded = encodeURIComponent(text);
  for (let attempt = 0; attempt < LINGVA_INSTANCES.length; attempt++) {
    const host = LINGVA_INSTANCES[(lingvaIndex + attempt) % LINGVA_INSTANCES.length];
    try {
      const url = `https://${host}/api/v1/en/${codes.lingva}/${encoded}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) continue;
      const data = await response.json();
      if (data && data.translation) {
        lingvaIndex = (lingvaIndex + attempt) % LINGVA_INSTANCES.length;
        return data.translation;
      }
    } catch (e) { continue; }
  }
  throw new Error('All Lingva instances failed');
}

// ===== Provider management =====
const providers = [
  { name: 'Google',   fn: googleTranslate },
  { name: 'Bing',     fn: bingTranslate },
  { name: 'MyMemory', fn: myMemoryTranslate },
  { name: 'Lingva',   fn: lingvaTranslate },
];
let currentProvider = 0;

// ===== Main translation function =====
async function translateViaAPI(text, retries = 2) {
  const cached = getCached(text, targetLang);
  if (cached) return cached;
  
  const encoded = encodeURIComponent(text);
  if (encoded.length > 4000) {
    const mid = Math.floor(text.length / 2);
    let splitAt = text.lastIndexOf(' ', mid);
    if (splitAt < mid / 2) splitAt = mid;
    const part1 = await translateViaAPI(text.substring(0, splitAt));
    const part2 = await translateViaAPI(text.substring(splitAt).trimStart());
    const result = part1 + part2;
    setCache(text, targetLang, result);
    return result;
  }
  
  for (let p = 0; p < providers.length; p++) {
    const providerIdx = (currentProvider + p) % providers.length;
    const provider = providers[providerIdx];
    
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const result = await provider.fn(text);
        if (result && result.length > 0) {
          if (providerIdx !== currentProvider) {
            console.log(`[ST] Switched to ${provider.name} provider`);
            currentProvider = providerIdx;
          }
          setCache(text, targetLang, result);
          return result;
        }
      } catch (e) {
        console.warn(`[ST] ${provider.name} attempt ${attempt + 1} failed:`, e.message);
        if (attempt < retries - 1) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
    }
    console.warn(`[ST] ${provider.name} failed, trying next...`);
  }
  
  console.error('[ST] All providers failed for:', text.substring(0, 50));
  return text;
}

// ===== Load settings on startup =====
chrome.storage.sync.get({ preferredProvider: 0, targetLang: 'zh-CN' }, (data) => {
  currentProvider = data.preferredProvider;
  targetLang = data.targetLang;
  console.log(`[ST] Provider: ${providers[currentProvider]?.name}, Language: ${targetLang}`);
});

// ===== Message Handler =====
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  
  if (request.action === 'setProvider') {
    currentProvider = request.provider;
    console.log(`[ST] Provider → ${providers[currentProvider]?.name}`);
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'setTargetLang') {
    targetLang = request.lang;
    // Clear cache when language changes (old translations are wrong language)
    translationCache.clear();
    console.log(`[ST] Target language → ${targetLang}`);
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'getStatus') {
    sendResponse({
      activeProvider: currentProvider,
      cacheSize: translationCache.size,
      targetLang: targetLang,
      providers: providers.map(p => p.name)
    });
    return false;
  }

  if (request.action === 'translate') {
    translateViaAPI(request.text)
      .then(translation => sendResponse({ success: true, translation }))
      .catch(error => {
        console.error("Translation error:", error);
        sendResponse({ success: false, error: error.message || 'Translation failed' });
      });
    return true;
  }

  if (request.action === 'fetchUrl') {
    fetch(request.url)
      .then(response => response.text())
      .then(text => sendResponse({ success: true, data: text }))
      .catch(error => {
        console.error("Fetch error:", error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (request.action === 'translateBatch') {
    const texts = request.texts;
    if (texts.length === 0) {
      sendResponse({ success: true, translations: [] });
      return true;
    }

    const combined = texts.join('\n');
    translateViaAPI(combined)
      .then(fullTranslation => {
        const parts = fullTranslation.split('\n');
        const translations = texts.map((original, i) => {
          const translated = parts[i] || original;
          if (parts[i]) setCache(original, targetLang, parts[i]);
          return translated;
        });
        sendResponse({ success: true, translations });
      })
      .catch(error => {
        console.error("Batch translation error:", error);
        sendResponse({ success: true, translations: texts });
      });
    return true;
  }
});
