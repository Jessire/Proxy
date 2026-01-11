/*
========================================
🤖 YouTube 双语字幕 (Sur2b QX 适配版)
========================================

[rewrite_local]
# 1. 拦截配置请求 (捷径写入配置)
^https:\/\/www\.youtube\.com\/api\/timedtextConf url script-request-body Sur2b_QX.js

# 2. 拦截字幕请求 (执行翻译)
^https:\/\/www\.youtube\.com\/api\/timedtext\? url script-response-body Sur2b_QX.js

[mitm]
hostname = www.youtube.com

========================================
*/

// ⬇️ 以下是核心脚本代码 ⬇️

// --- 1. 兼容层 Polyfill ---
const $persistentStore = {
    read: (key) => $prefs.valueForKey(key),
    write: (val, key) => $prefs.setValueForKey(val, key)
};
const $notification = {
    post: (title, subtitle, body) => $notify(title, subtitle, body)
};
const $httpClient = {
    post: (params, cb) => {
        let opts = typeof params === 'string' ? {url: params} : params;
        opts.method = 'POST';
        // 移除 Content-Length 防止 QX 发送失败
        if(opts.headers) delete opts.headers['Content-Length']; 
        $task.fetch(opts).then(r => cb(null,r,r.body), e => cb(e,null,null));
    }
};
const $done = (o={}) => {
    if(o.response && o.response.body) o.body = o.response.body;
    globalThis.$done(o);
};

// --- 2. 主逻辑 ---

const url = $request.url;
let body = $response ? $response.body : "";

(async () => {
    
    // 🟢 场景一：处理捷径发来的配置 (api/timedtextConf)
    // 必须匹配 script-request-body
    if (url.includes('timedtextConf')) {
        if ($request.body) {
            try {
                let rawBody = $request.body;
                let newConf = JSON.parse(rawBody);

                // 处理清除缓存指令
                if (newConf.delCache) {
                    $persistentStore.write('{}', 'Sur2bCache');
                }
                delete newConf.delCache;

                // 写入配置到 QX 存储
                const success = $persistentStore.write(JSON.stringify(newConf), 'Sur2bConf');
                
                if (success) {
                    $notification.post('Sur2b', '配置已保存 ✅', `目标语言: ${newConf.targetLanguage} | 模式: ${newConf.subLine === 1 ? '双语' : '单语'}`);
                } else {
                    $notification.post('Sur2b', '保存失败 ❌', '无法写入配置，请检查权限');
                }
            } catch (e) {
                $notification.post('Sur2b', '配置解析失败 ❌', e.message);
            }
        }
        // 直接返回 OK，让捷径完成运行
        $done({ response: { status: 200, body: '{"status": "OK"}' } });
        return;
    }

    // 🔵 场景二：处理字幕请求 (api/timedtext?)
    // 必须匹配 script-response-body

    // 1. 读取配置
    let confStr = $persistentStore.read('Sur2bConf');
    if (!confStr) {
        // 如果没有配置，静默退出，防止刷屏打扰
        // console.log("Sur2b: 尚未配置，请运行捷径"); 
        $done({});
        return;
    }
    let conf = JSON.parse(confStr);

    // 2. 过滤无需翻译的情况
    if (url.includes('&kind=asr')) { // 自动生成的字幕通常质量差且格式不同，跳过
        $done({});
        return;
    }
    if (url.includes('&tlang=')) { // 已经是翻译过的字幕，跳过
        $done({});
        return;
    }

    // 3. 检查字幕格式 (仅支持 XML)
    if (!body || !body.includes('<p t=')) {
        $done({});
        return;
    }

    // 4. 提取原文
    const regex = /<p t="\d+" d="\d+">([^<]+)<\/p>/g;
    const originalSubs = [];
    let match;
    while ((match = regex.exec(body)) !== null) {
        originalSubs.push(match[1]);
    }

    if (originalSubs.length === 0) {
        $done({});
        return;
    }

    // 5. 执行翻译
    try {
        // 强制使用 Google 翻译以保证稳定性
        const translatedText = await googleTranslate(originalSubs, conf.targetLanguage);
        
        // 6. 替换并回填字幕
        let i = 0;
        const newBody = body.replace(regex, (full, origin) => {
            if (i < translatedText.length) {
                const trans = translatedText[i++];
                
                // 强制去除换行符，防止 XML 格式错误
                const cleanTrans = trans.replace(/\r?\n|\r/g, " ");

                // 模式 1: 双语 (译文在上，原文在下) - 最常用
                if (conf.subLine == 1) return full.replace(origin, `${cleanTrans}\n${origin}`);
                // 模式 2: 双语 (原文在上，译文在下)
                if (conf.subLine == 2) return full.replace(origin, `${origin}\n${cleanTrans}`);
                // 模式 0: 仅译文
                return full.replace(origin, cleanTrans);
            }
            return full;
        });
        
        // console.log("Sur2b: 字幕翻译完成");
        $done({ body: newBody });

    } catch (e) {
        console.log('Sur2b 翻译失败: ' + e);
        $done({}); // 失败则返回原字幕
    }

})();

// --- 3. 翻译函数 (Google 接口) ---
async function googleTranslate(texts, targetLang) {
    // 分批处理，防止 URL 过长导致 414 错误
    const batchSize = 30; 
    let results = [];
    
    // 修正语言代码 (捷径传来的可能是 ZH-HANS，Google 需要 zh-CN)
    let tl = targetLang;
    if (tl.toLowerCase() === 'zh-hans') tl = 'zh-CN';
    if (tl.toLowerCase() === 'zh-hant') tl = 'zh-TW';

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        // 使用特殊符号作为分隔符
        const q = batch.join('\n[~~~]\n'); 
        
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=${tl}&q=${encodeURIComponent(q)}`;
        
        await new Promise(resolve => {
            $httpClient.post({
                url: url,
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' 
                }
            }, (err, resp, data) => {
                if (!err && data) {
                    try {
                        // Google 返回的是多重数组 JSON
                        const json = JSON.parse(data);
                        let block = "";
                        if(json[0]) {
                            json[0].forEach(item => { 
                                if(item[0]) block += item[0]; 
                            });
                        }
                        // 按分隔符切分回数组
                        const parts = block.split(/\n\s*\[~~~\]\s*\n?/);
                        results = results.concat(parts);
                    } catch (e) {
                        results = results.concat(batch); // 解析失败回填原文
                    }
                } else {
                    results = results.concat(batch); // 请求失败回填原文
                }
                resolve();
            });
        });
    }
    return results;
}
