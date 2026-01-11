// ==============================================
// 🤖 Quantumult X 兼容补丁 (Polyfill for Surge)
// 使用方法：将此段代码放在脚本最前面，后面紧跟原脚本代码
// ==============================================

// 1. 模拟 $httpClient
const $httpClient = {
    get: (params, cb) => {
        const options = typeof params === 'string' ? { url: params } : params;
        $task.fetch(options).then(resp => {
            cb(null, resp, resp.body);
        }, err => cb(err, null, null));
    },
    post: (params, cb) => {
        const options = typeof params === 'string' ? { url: params, method: 'POST' } : params;
        // 修正 header 格式差异
        if (options.headers) delete options.headers['Content-Length']; 
        $task.fetch(options).then(resp => {
            cb(null, resp, resp.body);
        }, err => cb(err, null, null));
    }
};

// 2. 模拟 $persistentStore
const $persistentStore = {
    read: (key) => $prefs.valueForKey(key),
    write: (val, key) => $prefs.setValueForKey(val, key)
};

// 3. 模拟 $notification
const $notification = {
    post: (title, subtitle, body) => $notify(title, subtitle, body)
};

// 4. 模拟 $done
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
// 👇 Sur2b.js 原始内容 (已修改为硬编码配置) 👇
// ==============================================

/*
    Sur2b by Neurogram (Modified for QX Hardcode)
*/

const url = $request.url;
let body, subtitleData;

// 【在此修改配置】 👇👇👇
let conf = {
    targetLanguage: 'zh-CN',    // 目标语言: zh-CN (简体), zh-TW (繁体)
    subLine: 1,                 // 模式: 1 (翻译+原声), 2 (原声+翻译), 0 (仅翻译)
    videoTranslation: true,     // 开启视频翻译
    translationProvider: 'Google', // 翻译引擎: Google 或 DeepL
    
    // 以下为默认设置，通常无需修改
    videoSummary: false,        // 视频摘要(需要key, 这里默认关掉)
    cacheMaxHours: 12,          // 缓存时间
    translationMaxMinutes: 120, // 超过多少分钟不翻译
    openAIAPIKey: '',           // 如果要用摘要需填 Key
    openAIModel: 'gpt-3.5-turbo',
    deepLAPIKey: ''             // 如果用 DeepL 需填 Key
};
// 👆👆👆

const autoGenSub = url.includes('&kind=asr');
const videoID = url.match(/(\?|&)v=([^&]+)/)?.[2];
const sourceLang = url.match(/&lang=([^&]+)/)?.[1];
let cache = $persistentStore.read('Sur2bCache') || '{}';
cache = JSON.parse(cache);

(async () => {

    // 移除了配置更新逻辑，因为我们是写死的
    // 移除了 conf 检查逻辑

    body = $response.body;
    subtitleData = processTimedText(body);

    if (!subtitleData.processedText) {
        // 如果未匹配到字幕，安静退出，不弹窗打扰
        // $notification.post('Sur2b', '', '未匹配到字幕内容'); 
        return $done({});
    };

    let summaryContent, translatedBody;

    if (conf.videoSummary && subtitleData.maxT <= conf.summaryMaxMinutes * 60 * 1000) summaryContent = await summarizer();
    if (conf.videoTranslation && subtitleData.maxT <= conf.translationMaxMinutes * 60 * 1000) translatedBody = await translator();

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
        $notification.post('YouTube 视频摘要', '', cache[videoID][sourceLang].summary.content);
        return;
    };

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
        if (!conf.openAIProxyUrl) throw new Error('未配置 AI 总结接口链接');
        if (!conf.openAIAPIKey) throw new Error('未配置 AI 总结接口 API Key');
        if (!conf.openAIModel) throw new Error('未配置 AI 总结接口模型');

        const resp = await sendRequest(options, 'post');
        if (resp.error) throw new Error(resp.error.message);
        const content = resp.choices[0].message.content;
        $notification.post('YouTube 视频摘要', '', content);
        return content;
    } catch (err) {
        $notification.post('YouTube 视频摘要', '摘要请求失败', err);
        return;
    };

};


async function translator() {

    if (cache[videoID]?.[sourceLang]?.translation?.[conf.targetLanguage]) {
        body = cache[videoID][sourceLang].translation[conf.targetLanguage].content;
        return;
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
            $notification.post('YouTube 视频翻译', '翻译请求失败', error);
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

    if (!resp.sentences) throw new Error(`Google 翻译失败: ${JSON.stringify(resp)}`);

    const combinedTrans = resp.sentences.map(s => s.trans).join('');

    const splitSentences = combinedTrans.split('<p>');

    const targetSubs = splitSentences
        .filter(sentence => sentence && sentence.trim().length > 0)
        .map(sentence => {
            return sentence.replace(/\s*[\r\n]+\s*/g, ' ').trim();
        });

    return targetSubs;
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

    if (!resp.translations) throw new Error(`DeepL 翻译失败: ${JSON.stringify(resp)}`);

    const targetSubs = resp.translations.map(translation => translation.text);

    return targetSubs;
};

async function chineseTransform() {

    let from = 'cn';
    let to = 'tw';

    if (/^zh-(CN|HANS)/i.test(conf.targetLanguage)) [from, to] = [to, from];

    const openccJS = await sendRequest({
        url: 'https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/umd/full.js'
    })
    eval(openccJS);

    const converter = OpenCC.Converter({ from: from, to: to });

    body = converter(body)
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
            if (words.length > 0) {
                lineText = words.join('');
            }
        } else {
            lineText = content;
        }

        lineText = decodeHTMLEntities(lineText).trim();

        if (lineText) {
            if (t > maxT) {
                maxT = t;
            }

            const totalSeconds = Math.floor(t / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            const paddedSeconds = String(seconds).padStart(2, '0');
            let formattedTime;

            if (hours > 0) {
                const paddedMinutes = String(minutes).padStart(2, '0');
                formattedTime = `(${hours}:${paddedMinutes}:${paddedSeconds})`;
            } else {
                formattedTime = `(${minutes}:${paddedSeconds})`;
            }

            results.push(`${formattedTime} ${lineText}`);
        }
    }

    const processedText = results.join('\n');

    return {
        processedText: processedText,
        maxT: maxT
    };
};

function decodeHTMLEntities(text) {
    const entities = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#39;': '\''
    };
    return text.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, match => entities[match]);
};

function sendRequest(options, method = 'get') {
    return new Promise((resolve, reject) => {
        $httpClient[method](options, (error, response, data) => {
            if (error) {
                return reject(error);
            };
            try {
                resolve(JSON.parse(data));
            } catch {
                resolve(data);
            };
        });
    });
};

function cleanCache() {
    const now = Date.now();
    const maxMs = conf.cacheMaxHours * 60 * 60 * 1000;

    for (const itemKey of Object.keys(cache)) {
        const item = cache[itemKey];

        for (const lang of Object.keys(item)) {
            const langObj = item[lang];

            if (langObj.summary && now - langObj.summary.timestamp > maxMs) {
                delete langObj.summary;
            };

            if (langObj.translation) {

                for (const tLang of Object.keys(langObj.translation)) {
                    const tObj = langObj.translation[tLang];
                    if (now - tObj.timestamp > maxMs) {
                        delete langObj.translation[tLang];
                    };
                };

                if (Object.keys(langObj.translation).length === 0) {
                    delete langObj.translation;
                };
            };

            if ((!langObj.summary) && (!langObj.translation)) delete item[lang];
        };

        if (Object.keys(item).length === 0) delete cache[itemKey];
    };

    return cache;
}
