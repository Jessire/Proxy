/*
=============================================================
🤖 Quantumult X 配置指南 (仅供参考，无需复制到 JS 文件中)
[rewrite_local]
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
        $task.fetch(options).then(resp => cb(null, resp, resp.body), err => cb(err, null, null));
    },
    post: (params, cb) => {
        const options = typeof params === 'string' ? { url: params, method: 'POST' } : params;
        if (options.headers) delete options.headers['Content-Length']; 
        $task.fetch(options).then(resp => cb(null, resp, resp.body), err => cb(err, null, null));
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
    if (obj.response && obj.response.body) {
        obj.body = obj.response.body;
        delete obj.response;
    }
    if (obj.headers && obj.headers['Content-Length']) delete obj.headers['Content-Length'];
    globalThis.$done(obj);
};

// ==============================================
// 🔴 2. 用户自定义配置区
// ==============================================
const userConfig = {
    targetLanguage: "zh-CN", // 目标语言
    translationProvider: "Google", // 翻译引擎
    subLine: 1, // 0:仅翻译, 1:翻译+原文, 2:原文+翻译
    videoSummary: false, // 暂时关掉摘要以排查问题
    videoTranslation: true,
    summaryMaxMinutes: 60,
    translationMaxMinutes: 60,
    openAIAPIKey: "sk-xxx", 
    openAIProxyUrl: "https://api.openai.com/v1/chat/completions",
    openAIModel: "gpt-3.5-turbo",
    summaryPrompts: "Summary: {{subtitles}}",
    cacheMaxHours: 12
};

// ==============================================
// 3. 核心逻辑 Sur2b
// ==============================================
const url = $request.url;
let body = $response.body;
let subtitleData;

// 读取配置
let confStr = $persistentStore.read('Sur2bConf');
let conf = userConfig;
try {
    if (confStr && confStr !== "null") conf = JSON.parse(confStr);
} catch (e) { conf = userConfig; }
if (!conf) conf = userConfig;

const videoID = url.match(/(\?|&)v=([^&]+)/)?.[2];
const sourceLang = url.match(/&lang=([^&]+)/)?.[1];
let cache = $persistentStore.read('Sur2bCache') || '{}';
try { cache = JSON.parse(cache); } catch (e) { cache = {}; }

(async () => {
    // 拦截配置请求
    if (url.includes('timedtextConf')) return $done({});

    if (!body) return $done({});

    // 提取字幕
    subtitleData = processTimedText(body);
    if (!subtitleData.processedText) return $done({});

    let translatedBody;

    // 执行翻译
    if (conf.videoTranslation) {
        translatedBody = await translator();
    }

    // 写入缓存 (简化逻辑)
    if (translatedBody && videoID && sourceLang) {
        if (!cache[videoID]) cache[videoID] = {};
        if (!cache[videoID][sourceLang]) cache[videoID][sourceLang] = {};
        cache[videoID][sourceLang].translation = {}; // 清理旧结构
        cache[videoID][sourceLang].translation[conf.targetLanguage] = {
            content: translatedBody,
            timestamp: Date.now()
        };
        $persistentStore.write(JSON.stringify(cache), 'Sur2bCache');
    }

    $done({ body });
})();

async function translator() {
    // 检查缓存
    if (cache[videoID]?.[sourceLang]?.translation?.[conf.targetLanguage]) {
        body = cache[videoID][sourceLang].translation[conf.targetLanguage].content;
        return body; 
    }

    // 检查是否无需翻译
    if (url.includes(`&lang=${conf.targetLanguage}`) || url.includes('&tlang=')) return;

    // 提取原文
    const originalSubs = [];
    const regex = /<p t="(\d+)"[^>]*>(.*?)<\/p>/g;
    let match;
    while ((match = regex.exec(body)) !== null) {
        // 这里的 match[2] 是字幕内容
        originalSubs.push(match[2]);
    }

    if (originalSubs.length === 0) return;

    // 分批翻译
    const targetSubs = [];
    const batchSize = 50; 

    for (let i = 0; i < originalSubs.length; i += batchSize) {
        const batch = originalSubs.slice(i, i + batchSize);
        try {
            // 清理 HTML 标签再送去翻译
            const cleanBatch = batch.map(s => s.replace(/<[^>]+>/g, ""));
            const translatedBatch = await googleTranslator(cleanBatch);
            targetSubs.push(...translatedBatch);
        } catch (error) {
            console.log("❌ 翻译中断: " + error.message);
            return; // 失败则直接返回原字幕
        }
    }

    // 替换回 Body
    let subIndex = 0;
    // 重置正则
    const replaceRegex = /<p (t="\d+"[^>]*)>(.*?)<\/p>/g;
    const translatedBody = body.replace(replaceRegex, (fullMatch, attributes, content) => {
        if (subIndex < targetSubs.length) {
            const originalText = content;
            const translatedText = targetSubs[subIndex];
            let finalSubText = translatedText;

            if (conf.subLine === 1) finalSubText = `${translatedText}\n${originalText}`;
            if (conf.subLine === 2) finalSubText = `${originalText}\n${translatedText}`;

            subIndex++;
            return `<p ${attributes}>${finalSubText}</p>`;
        }
        return fullMatch;
    });

    body = translatedBody;
    return translatedBody;
}

// 🟢 修复后的 Google 翻译函数 (GTX 模式 + GET)
async function googleTranslator(subs) {
    // 使用 gtx 接口，抗封锁能力强，不需要 User-Agent
    const query = subs.join('\n');
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=${conf.targetLanguage}&q=${encodeURIComponent(query)}`;
    
    const options = {
        url: url,
        headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" // 伪装成 Mac 浏览器
        }
    };

    let resp;
    try {
        resp = await sendRequest(options, 'get');
    } catch (err) {
        throw new Error(`网络请求错误: ${err}`);
    }

    if (!resp || !resp[0]) throw new Error('Google API 响应为空');

    // 解析 gtx 返回格式
    let combinedTrans = "";
    resp[0].forEach(item => {
        if (item[0]) combinedTrans += item[0];
    });

    // 分割行
    return combinedTrans.split('\n').map(s => s ? s.trim() : "").filter(s => s.length > 0);
}

function processTimedText(xml) {
    // 简单提取，用于校验
    const regex = /<p t="(\d+)"[^>]*>(.*?)<\/p>/gs;
    let match;
    let hasText = false;
    while ((match = regex.exec(xml)) !== null) {
        hasText = true;
        break;
    }
    return { processedText: hasText };
}

function sendRequest(options, method = 'get') {
    return new Promise((resolve, reject) => {
        $httpClient[method](options, (error, response, data) => {
            if (error) return reject(error);
            try { resolve(JSON.parse(data)); } catch { resolve(data); }
        });
    });
}
