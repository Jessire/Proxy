/*
=============================================================
🤖 Quantumult X 配置文件添加指南
=============================================================

[rewrite_local]
# YouTube 字幕增强 (路径请根据实际情况修改)
^https:\/\/www\.youtube\.com\/api\/timedtext\? url script-response-body https://raw.githubusercontent.com/Jessire/Proxy/refs/heads/master/u.js
[mitm]
hostname = www.youtube.com

=============================================================
*/

// ==============================================
// 1. QX 兼容补丁 (Polyfill)
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
// 🔴 2. 用户自定义配置区 (在这里修改参数)
// ==============================================
const userConfig = {
    // 目标语言 (zh-CN: 简体, zh-TW: 繁体, en: 英文)
    targetLanguage: "zh-CN",

    // 翻译引擎: "Google" (免费) 或 "DeepL" (需API Key)
    translationProvider: "Google", 

    // 显示模式: 0(仅翻译), 1(翻译+原文), 2(原文+翻译)
    subLine: 1,

    // 功能开关
    videoSummary: true,       // AI 摘要开关 (没填Key会自动跳过)
    videoTranslation: true,   // 翻译开关

    // 视频时长限制 (分钟)
    summaryMaxMinutes: 60,
    translationMaxMinutes: 45,

    // OpenAI 配置 (如果不需要摘要，可以不管)
    openAIAPIKey: "sk-xxxxxxxxxxxxxxxxxxxxxxxx", 
    openAIProxyUrl: "https://api.openai.com/v1/chat/completions",
    openAIModel: "gpt-3.5-turbo",
    summaryPrompts: "Video summary:\n\n{{subtitles}}",

    // DeepL 配置 (如果 translationProvider 选了 DeepL 则必填)
    deepLAPIKey: "", 
    deepLUrl: "https://api-free.deepl.com/v2/translate",

    cacheMaxHours: 12
};

// ==============================================
// 3. 核心逻辑 Sur2b
// ==============================================

const url = $request.url;
let body, subtitleData;

// 读取配置逻辑：优先读本地存储，失败则读 userConfig
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
// 双重保险
if (!conf) conf = userConfig;

const autoGenSub = url.includes('&kind=asr');
const videoID = url.match(/(\?|&)v=([^&]+)/)?.[2];
const sourceLang = url.match(/&lang=([^&]+)/)?.[1];
let cache = $persistentStore.read('Sur2bCache') || '{}';
try { cache = JSON.parse(cache); } catch (e) { cache = {}; }

(async () => {
    // 拦截配置请求 (兼容性保留)
    if (url.includes('timedtextConf')) {
        try {
            let newConf = JSON.parse($request.body);
            if (newConf.delCache) $persistentStore.write('{}', 'Sur2bCache');
            delete newConf.delCache;
            $persistentStore.write(JSON.stringify(newConf), 'Sur2bConf');
            return $done({ response: { body: 'OK' } });
        } catch (e) { return $done({}); }
    };

    body = $response.body;
    
    // 如果 body 为空或非文本，直接返回
    if (!body) return $done({});

    subtitleData = processTimedText(body);

    if (!subtitleData.processedText) {
        // console.log("Sur2b: 未提取到字幕文本，可能是格式不支持");
        return $done({});
    };

    let summaryContent, translatedBody;

    // 摘要逻辑
    if (conf.videoSummary && subtitleData.maxT <= conf.summaryMaxMinutes * 60 * 1000) {
        summaryContent = await summarizer();
    }
    
    // 翻译逻辑
    if (conf.videoTranslation && subtitleData.maxT <= conf.translationMaxMinutes * 60 * 1000) {
        translatedBody = await translator();
    }

    // 缓存逻辑
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
        $notification.post('YouTube 摘要 (Cached)', '', cache[videoID][sourceLang].summary.content);
        return;
    };

    // 检查 Key 是否有效
    if (!conf.openAIAPIKey || conf.openAIAPIKey.includes("sk-xxx") || conf.openAIAPIKey.length < 10) {
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
                { role: 'user', content: conf.summaryPrompts.replace(/{{subtitles}}/, subtitleData.processedText) }
            ]
        }
    };

    try {
        const resp = await sendRequest(options, 'post');
        if (resp.error) throw new Error(resp.error.message);
        
        let content = "";
        if (resp.choices && resp.choices[0]?.message) content = resp.choices[0].message.content;
        
        if (content) {
            $notification.post('YouTube 视频摘要', '', content);
            return content;
        }
    } catch (err) {
        // console.log("摘要失败: " + err);
        return;
    };
};


async function translator() {
    // 检查缓存
    if (cache[videoID]?.[sourceLang]?.translation?.[conf.targetLanguage]) {
        body = cache[videoID][sourceLang].translation[conf.targetLanguage].content;
        return body; 
    };

    // 检查是否已经是目标语言
    let patt = new RegExp(`&lang=${conf.targetLanguage}&`, 'i');
    if (conf.targetLanguage == 'zh-CN' || conf.targetLanguage == 'ZH-HANS') patt = /&lang=zh(-Hans)*&/i;
    if (conf.targetLanguage == 'zh-TW' || conf.targetLanguage == 'ZH-HANT') patt = /&lang=zh-Hant&/i;
    if (url.includes('&tlang=') || patt.test(url)) return;

    // 简繁转换特殊处理
    if (/&lang=zh(-Han)*/i.test(url) && /^zh-(CN|TW|HAN)/i.test(conf.targetLanguage)) return await chineseTransform();

    // 🔴 关键修改：允许自动生成的字幕进行翻译 (原版此处会 return)
    // if (autoGenSub) return; 

    const originalSubs = [];
    // 匹配字幕行
    const regex = /<p t="(\d+)" d="(\d+)"(?:[^>]*)>([^<]+)<\/p>/g;
    let match;

    // 必须重置 lastIndex 否则 exec 可能出问题
    regex.lastIndex = 0;
    
    // 提取原文
    while ((match = regex.exec(body)) !== null) {
        originalSubs.push(match[3]); // 这里的 index 3 是字幕文本
    }

    if (originalSubs.length === 0) {
        // 尝试匹配另一种格式 (无 d 属性或属性顺序不同)
        const backupRegex = /<p t="(\d+)"[^>]*>(.*?)<\/p>/g;
        while ((match = backupRegex.exec(body)) !== null) {
             originalSubs.push(match[2]);
        }
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
            console.log("翻译请求失败: " + JSON.stringify(error));
            return; 
        }
    };

    // 替换回 body
    let subIndex = 0;
    // 使用更通用的替换正则
    const replaceRegex = /<p (t="\d+"[^>]*)>(.*?)<\/p>/g;
    
    const translatedBody = body.replace(replaceRegex, (fullMatch, attributes, content) => {
        if (subIndex < targetSubs.length) {
            const originalText = decodeHTMLEntities(content); // 解码原文以去除干扰
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
            return `<p ${attributes}>${finalSubText}</p>`;
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
            return await googleTranslator(subs); // 默认回落到 Google
    }
};

async function googleTranslator(subs) {
    // ⚠️ 修改点1: 这里的 client 从 'it' 改为了 'gtx' (Web通用接口，抗封锁能力更强)
    // ⚠️ 修改点2: 去掉了 User-Agent 伪装，有时不伪装反而更好
    const options = {
        url: `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=${conf.targetLanguage}&q=${encodeURIComponent(subs.join('\n'))}`,
        headers: {
            // 这里留空，让 QX 自动处理
        }
    };

    // ⚠️ 修改点3: 增加了详细的错误日志打印，不再显示 {}
    let resp;
    try {
        resp = await sendRequest(options, 'get'); // 注意这里改成了 get 请求
    } catch (err) {
        // 强制打印真实错误信息
        const errMsg = err.message || JSON.stringify(err);
        console.log(`❌ Google 翻译请求失败 (这是关键报错): ${errMsg}`);
        throw err;
    }

    if (!resp || !resp[0]) {
        console.log(`❌ Google 返回数据异常: ${JSON.stringify(resp)}`);
        throw new Error('Google API 响应格式错误');
    }

    // gtx 接口返回的数据结构是 [[["翻译","原文"],...]]
    // 下面的逻辑用于提取翻译结果
    let combinedTrans = "";
    resp[0].forEach(item => {
        if (item[0]) combinedTrans += item[0];
    });

    const splitSentences = combinedTrans.split('\n');
    
    // 过滤空行
    const final = splitSentences
        .map(s => s ? s.trim() : "")
        .filter(s => s.length > 0);
        
    return final;
};


async function deepLTranslator(subs) {
    if (!conf.deepLAPIKey) throw new Error('未配置 DeepL API Key');
    const options = {
        url: conf.deepLUrl || 'https://api-free.deepl.com/v2/translate',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'DeepL-Auth-Key ' + conf.deepLAPIKey,
        },
        body: { text: subs, target_lang: conf.targetLanguage }
    };
    const resp = await sendRequest(options, 'post');
    if (!resp.translations) throw new Error(`DeepL API 响应异常`);
    return resp.translations.map(translation => translation.text);
};

async function chineseTransform() {
    let from = 'cn', to = 'tw';
    if (/^zh-(CN|HANS)/i.test(conf.targetLanguage)) [from, to] = [to, from];
    try {
        const openccJS = await sendRequest({ url: 'https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/umd/full.js' });
        eval(openccJS);
        const converter = OpenCC.Converter({ from: from, to: to });
        body = converter(body);
    } catch (e) {}
};

function processTimedText(xml) {
    const regex = /<p t="(\d+)"[^>]*>(.*?)<\/p>/gs;
    let match, maxT = 0;
    const results = [];
    while ((match = regex.exec(xml)) !== null) {
        const t = parseInt(match[1], 10);
        let lineText = match[2].trim();
        // 去除内部标签如 <s>
        lineText = lineText.replace(/<[^>]+>/g, ""); 
        lineText = decodeHTMLEntities(lineText).trim();
        if (lineText) {
            if (t > maxT) maxT = t;
            const totalSeconds = Math.floor(t / 1000);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            results.push(`(${minutes}:${String(seconds).padStart(2,'0')}) ${lineText}`);
        }
    }
    return { processedText: results.join('\n'), maxT: maxT };
};

function decodeHTMLEntities(text) {
    const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'' };
    return text.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, match => entities[match]);
};

function sendRequest(options, method = 'get') {
    return new Promise((resolve, reject) => {
        $httpClient[method](options, (error, response, data) => {
            if (error) return reject(error);
            try { resolve(JSON.parse(data)); } catch { resolve(data); };
        });
    });
};

function cleanCache() {
    if (!cache) return {};
    return cache;
}
