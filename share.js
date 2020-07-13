
  const senku=init()
  const url = "https://ios.baertt.com/v2/article/share/put.json";
  const body = "access=WIFI&app_version=1.7.6&article_id=26471577&channel=80000000&channel_code=80000000&cid=80000000&client_version=1.7.6&device_brand=iphone&device_id=&device_model=iPhone&device_platform=iphone&device_type=iphone&from=6&is_hot=0&isnew=1&mobile_type=2&net_type=1&openudid=40a63cc2e75e202c8adc4a07cea02ba0&os_version=13.5&phone_code=40a63cc2e75e202c8adc4a07cea02ba0&phone_network=WIFI&platform=3&request_time=1592224504&resolution=750x1334&sign=4352591e0e542aece4f7d093ee3ca16f&sm_device_id=202003050042271be6f7e1519501f0c8cfe20776d2eeeb01ab07b4b4a15f45&stype=WEIXIN&szlm_ddid=D2vppoltywI1B2IrAKZE7wYgfuiNpCEM68t6UZzFTN47wXf6&time=1592224505&uid=46388633&uuid=40a63cc2e75e202c8adc4a07cea02ba0";
  const headers = {
    "Accept-Encoding": "gzip, deflate, br",
    "Accept": "*/*",
    "Connection": "keep-alive",
    "Content-Type": "application/x-www-form-urlencoded",
    "Host": "ios.baertt.com",
    "User-Agent": "KDApp/1.7.6 (iPhone; iOS 13.5; Scale/2.00)",
    "Accept-Language": "zh-Hans-CN;q=1, en-CN;q=0.9, zh-Hant-CN;q=0.8"
};
  const request = {
      url: url,
      headers: headers,
      body: body
  };
  
  senku.post(request, function(error, response, data) {
      try {
      	senku.log(data)
          const res=JSON.parse(data)
          //这里是以后要写的代码,大概几行就写完了
          senku.done();
          
      } catch(e) {
          senku.log(e)
          senku.done();
      }
  });
  
  function init() {
    isSurge = () => {
        return undefined === this.$httpClient ? false : true
    }
    isQuanX = () => {
        return undefined === this.$task ? false : true
    }
    getdata = (key) => {
        if (isSurge()) return $persistentStore.read(key)
        if (isQuanX()) return $prefs.valueForKey(key)
    }
    setdata = (key, val) => {
        if (isSurge()) return $persistentStore.write(key, val)
        if (isQuanX()) return $prefs.setValueForKey(key, val)
    }
    msg = (title, subtitle, body) => {
        if (isSurge()) $notification.post(title, subtitle, body)
        if (isQuanX()) $notify(title, subtitle, body)
    }
    log = (message) => console.log(message)
    get = (url, cb) => {
        if (isSurge()) {
            $httpClient.get(url, cb)
        }
        if (isQuanX()) {
            url.method = 'GET'
            $task.fetch(url).then((resp) => cb(null, resp, resp.body))
        }
    }
    post = (url, cb) => {
        if (isSurge()) {
            $httpClient.post(url, cb)
        }
        if (isQuanX()) {
            url.method = 'POST'
            $task.fetch(url).then((resp) => cb(null, resp, resp.body))
        }
    }
    done = (value = {}) => {
        $done(value)
    }
    return {
        isSurge,
        isQuanX,
        msg,
        log,
        getdata,
        setdata,
        get,
        post,
        done
    }
}
  