/*
=============================================================
🤖 Quantumult X 配置指南
=============================================================

请将以下内容添加到配置文件的对应区域：

[rewrite_local]
# YouTube 字幕增强 (请将 Sur2b_QX.js 替换为你保存的实际文件名)
^https:\/\/www\.youtube\.com\/api\/timedtext\? url script-response-body https://raw.githubusercontent.com/Jessire/Proxy/refs/heads/master/u.js

[mitm]
hostname = www.youtube.com

=============================================================
*/

// ==============================================
// 🤖 Quantumult X 兼容补丁 (Polyfill for Surge)
// ==============================================

const $httpClient = {
    get: (params, cb) => {
        const options = typeof params === 'string' ? { url: params } : params;
        $task.fetch(options).then(resp => {
            cb(null, resp, resp.body);
        }, err => cb(err, null, null));
    },
    post: (params, cb) => {
        const options = typeof params === 'string' ? { url: params, method: 'POST' } : params;
        if (options.headers) delete options.headers['Content-Length']; 
        $task.fetch(options).then(resp => {
            cb(null, resp, resp.body);
        }, err => cb(err, null, null));
    }
};

const $persistentStore = {
    read: (key) => $prefs.valueForKey(key),
    write: (val, key) => $prefs.setValueForKey(val, key)
};

const $notification = {
    post: (title, subtitle, body) => $notify(title, subtitle, body)
};

const $done = (obj = {}) => {
    if (obj.response) {
        if (obj.response.body) {
            obj.body = obj.response.body;
            delete obj.response;
        }
        if (obj.response.status) obj.status = obj.response.status;
        if (obj.response.headers) obj.headers = obj.response.headers;
    }
    if (obj.headers && obj.headers['Content-Length']) {
        delete obj.headers['Content-Length'];
    }
    globalThis.$done(obj);
};

// ==============================================
// 🔴 用户自定义配置 (QX 无法使用捷径，请在此处填写)
// ==============================================
const userConfig = {
    // 目标翻译语言 (例如: zh-CN, zh-TW, en, ja)
    targetLanguage: "zh-CN",

    // 翻译服务商: "Google" (免费/不稳定) 或 "DeepL" (需要Key/稳定)
    translationProvider: "Google", 

    // 字幕显示模式: 0 (仅翻译), 1 (翻译+原文), 2 (原文+翻译)
    subLine: 1,

    // 是否开启功能
    videoSummary: true,       // 是否开启 AI 视频摘要
    videoTranslation: true,   // 是否开启字幕翻译

    // 限制时长 (超过此时长的视频不处理，单位：分钟)
    summaryMaxMinutes: 60,
    translationMaxMinutes: 30,

    // --- OpenAI 配置 (开启摘要必须填) ---
    // 如果没有，请将 videoSummary 设为 false
    openAIAPIKey: "sk-xxxxxxxxxxxxxxxxxxxxxxxx", 
    openAIProxyUrl: "https://api.openai.com/v1/chat/completions",
    openAIModel: "gpt-3.5-turbo",
    summaryPrompts: "Video summary:\n\n{{subtitles}}",

    // --- DeepL 配置 (如果你选了 DeepL 必须填) ---
    deepLAPIKey: "", 
    deepLUrl: "https://api-free.deepl.com/v2/translate",

    // 缓存时间 (小时)
    cacheMaxHours: 12
};

// ==============================================
// 👇 核心逻辑 Sur2b (已适配 QX) 👇
// ==============================================

const url = $request.url;
let body, subtitleData;

// 优先读取本地存储(兼容旧逻辑)，读取失败则使用上方 userConfig
let confStr = $persistentStore.read('Sur2bConf');
let conf;

try {
    if (confStr && confStr !== "null" && confStr !== "undefined") {
        conf = JSON.parse(confStr);
    } else {
        conf = userConfig;
    }
} catch (e) {
    conf = userConfig;
}

if (!conf) conf = userConfig;

const autoGenSub = url.includes('&kind=asr');
const videoID = url.match(/(\?|&)v=([^&]+)/)?.[2];
const sourceLang = url.match(/&lang=([^&]+)/)?.[1];
let cache = $persistentStore.read('Sur2bCache') || '{}';
try {
    cache = JSON.parse(cache);
} catch (e) {
    cache = {};
}

(async () => {

    // 拦截配置请求 (保留兼容性)
    if (url.includes('timedtextConf')) {
        let newConf;
        try {
            newConf = JSON.parse($request.body);
            if (newConf.delCache) $persistentStore.write('{}', 'Sur2bCache');
            delete newConf.delCache;
            $persistentStore.write(JSON.stringify(newConf), 'Sur2bConf');
            return $done({ response: { body: 'OK' } });
        } catch (e) {
            return $done({});
        }
    };

    body = $response.body;
    subtitleData = processTimedText(body);

    if (!subtitleData.processedText) {
        return $done({});
    };

    let summaryContent, translatedBody;

    // 执行摘要
    if (conf.videoSummary && subtitleData.maxT <= conf.summaryMaxMinutes * 60 * 1000) {
        summaryContent = await summarizer();
    }
    
    // 执行翻译
    if (conf.videoTranslation && subtitleData.maxT <= conf.translationMaxMinutes * 60 * 1000) {
        translatedBody = await translator();
    }

    // 写入缓存
    if ((summaryContent || translatedBody) && videoID && sourceLang) {
        if (!cache[videoID]) cache[videoID] = {};
        if (!cache[videoID][sourceLang]) cache[videoID][sourceLang] = {};

        if (summaryContent) {
            cache[videoID][sourceLang].summary = {
                content: summaryContent,
                timestamp: new Date().getTime()
            };
        };

        if (translatedBody) {
            if (!cache[videoID][sourceLang].translation) cache[videoID][sourceLang].translation = {};
            cache[videoID][sourceLang].translation[conf.targetLanguage] = {
                content: translatedBody,
                timestamp: new Date().getTime()
            };
        };
    };

    cleanCache();
    $persistentStore.write(JSON.stringify(cache), 'Sur2bCache');

    $done({ body });

})();

async function summarizer() {

    if (cache[videoID]?.[sourceLang]?.summary) {
        $notification.post('YouTube 视频摘要 (Cached)', '', cache[videoID][sourceLang].summary.content);
        return;
    };

    if (!conf.openAIAPIKey || conf.openAIAPIKey.includes("sk-xxx")) {
        // console.log("⚠️ Sur2b: 未配置 OpenAI API Key，跳过摘要");
        return;
    }

    const options = {
        url: conf.openAIProxyUrl,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + conf.openAIAPIKey
        },
        body: {
            model: conf.openAIModel,
            messages: [
                {
                    role: 'user',
                    content: conf.summaryPrompts.replace(/{{subtitles}}/, subtitleData.processedText)
                }
            ]
        }
    };

    try {
        const resp = await sendRequest(options, 'post');
        if (resp.error) throw new Error(resp.error.message);
        
        let content = "";
        if (resp.choices && resp.choices[0] && resp.choices[0].message) {
             content = resp.choices[0].message.content;
        }
        
        if (content) {
            $notification.post('YouTube 视频摘要', '', content);
            return content;
        }
    } catch (err) {
        $notification.post('YouTube 视频摘要', '摘要请求失败', err);
        return;
    };
};


async function translator() {

    if (cache[videoID]?.[sourceLang]?.translation?.[conf.targetLanguage]) {
        body = cache[videoID][sourceLang].translation[conf.targetLanguage].content;
        return body; 
    };

    let patt = new RegExp(`&lang=${conf.targetLanguage}&`, 'i');

    if (conf.targetLanguage == 'zh-CN' || conf.targetLanguage == 'ZH-HANS') patt = /&lang=zh(-Hans)*&/i;
    if (conf.targetLanguage == 'zh-TW' || conf.targetLanguage == 'ZH-HANT') patt = /&lang=zh-Hant&/i;

    if (url.includes('&tlang=') || patt.test(url)) return;

    if (/&lang=zh(-Han)*/i.test(url) && /^zh-(CN|TW|HAN)/i.test(conf.targetLanguage)) return await chineseTransform();

    if (autoGenSub) return;

    const originalSubs = [];
    const regex = /<p t="\d+" d="\d+">([^<]+)<\/p>/g;
    let match;

    while ((match = regex.exec(body)) !== null) {
        originalSubs.push(match[1]);
    }

    if (originalSubs.length === 0) return;

    const targetSubs = [];
    const batchSize = 50;

    for (let i = 0; i < originalSubs.length; i += batchSize) {
        const batch = originalSubs.slice(i, i + batchSize);
        try {
            const translatedBatch = await translateSwitcher(batch);
            targetSubs.push(...translatedBatch);
        } catch (error) {
            // $notification.post('YouTube 视频翻译', '翻译请求失败', error);
            return; 
        }
    };

    let subIndex = 0;
    const translatedBody = body.replace(regex, (fullMatch) => {
        if (subIndex < targetSubs.length && subIndex < originalSubs.length) {
            const originalText = originalSubs[subIndex];
            const translatedText = targetSubs[subIndex];
            let finalSubText;

            switch (conf.subLine) {
                case 1:
                    finalSubText = `${translatedText}\n${originalText}`;
                    break;
                case 2:
                    finalSubText = `${originalText}\n${translatedText}`;
                    break;
                case 0:
                default:
                    finalSubText = translatedText;
                    break;
            }
            subIndex++;
            const attributesMatch = fullMatch.match(/<p (t="\d+" d="\d+")>/);
            return `<p ${attributesMatch[1]}>${finalSubText}</p>`;
        }
        return fullMatch;
    });

    body = translatedBody;
    return translatedBody;
};

async function translateSwitcher(subs) {
    switch (conf.translationProvider) {
        case 'Google':
            return await googleTranslator(subs);
        case 'DeepL':
            return await deepLTranslator(subs);
        default:
            throw new Error(`未知的翻译服务: ${conf.translationProvider}`);
    }
};

async function googleTranslator(subs) {
    const options = {
        url: `https://translate.google.com/translate_a/single?client=it&dt=qca&dt=t&dt=rmt&dt=bd&dt=rms&dt=sos&dt=md&dt=gt&dt=ld&dt=ss&dt=ex&otf=2&dj=1&hl=en&ie=UTF-8&oe=UTF-8&sl=auto&tl=${conf.targetLanguage}`,
        headers: {
            'User-Agent': 'GoogleTranslate/6.29.59279 (iPhone; iOS 15.4; en; iPhone14,2)'
        },
        body: `q=${encodeURIComponent('<p>' + subs.join('\n<p>'))}`
    };

    const resp = await sendRequest(options, 'post');
    if (!resp.sentences) throw new Error(`Google 翻译失败`);

    const combinedTrans = resp.sentences.map(s => s.trans).join('');
    const splitSentences = combinedTrans.split('<p>');

    return splitSentences
        .filter(sentence => sentence && sentence.trim().length > 0)
        .map(sentence => sentence.replace(/\s*[\r\n]+\s*/g, ' ').trim());
};


async function deepLTranslator(subs) {
    if (!conf.deepLAPIKey) throw new Error('未配置 DeepL API Key');

    const options = {
        url: conf.deepLUrl || 'https://api-free.deepl.com/v2/translate',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'DeepL-Auth-Key ' + conf.deepLAPIKey,
        },
        body: {
            text: subs,
            target_lang: conf.targetLanguage
        }
    };

    const resp = await sendRequest(options, 'post');
    if (!resp.translations) throw new Error(`DeepL 翻译失败`);
    return resp.translations.map(translation => translation.text);
};

async function chineseTransform() {
    let from = 'cn';
    let to = 'tw';
    if (/^zh-(CN|HANS)/i.test(conf.targetLanguage)) [from, to] = [to, from];

    const openccJS = await sendRequest({
        url: 'https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/umd/full.js'
    })
    try {
        eval(openccJS);
        const converter = OpenCC.Converter({ from: from, to: to });
        body = converter(body);
    } catch (e) {
        console.log("OpenCC 转换失败: " + e);
    }
};

function processTimedText(xml) {
    const regex = /<p t="(\d+)"[^>]*>(.*?)<\/p>/gs;
    let match;
    let maxT = 0;
    const results = [];

    while ((match = regex.exec(xml)) !== null) {
        const t = parseInt(match[1], 10);
        const content = match[2].trim();
        let lineText = '';

        if (content.startsWith('<s')) {
            const sTagRegex = /<s[^>]*>([^<]+)<\/s>/g;
            const words = Array.from(content.matchAll(sTagRegex), m => m[1]);
            if (words.length > 0) lineText = words.join('');
        } else {
            lineText = content;
        }

        lineText = decodeHTMLEntities(lineText).trim();

        if (lineText) {
            if (t > maxT) maxT = t;
            const totalSeconds = Math.floor(t / 1000);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            results.push(`(${minutes}:${String(seconds).padStart(2,'0')}) ${lineText}`);
        }
    }
    return {
        processedText: results.join('\n'),
        maxT: maxT
    };
};

function decodeHTMLEntities(text) {
    const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'' };
    return text.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, match => entities[match]);
};

function sendRequest(options, method = 'get') {
    return new Promise((resolve, reject) => {
        $httpClient[method](options, (error, response, data) => {
            if (error) return reject(error);
            try {
                resolve(JSON.parse(data));
            } catch {
                resolve(data);
            };
        });
    });
};

function cleanCache() {
    if (!cache) return {};
    return cache;
}
