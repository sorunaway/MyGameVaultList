# vendor/ — 第三方依赖自托管

这里存放**不跟随外部 CDN 加载**的第三方资源。目的是去掉外部域名这个单点：
只要 CDN 域名抽风，页面上的功能就会整块失效，而它偏偏是登录/同步的必经之路。

## index.global.js

WorkBuddy 云服务 JS SDK（浏览器全局版）。页面上**唯一**的外部依赖，现已自托管。

| 项 | 值 |
|---|---|
| 包 | `@tencent-ai/workbuddy-cloud-sdk` |
| dist-tag | `dev` |
| 文件 | `lib/index.global.js` |
| 大小 | 60,265 字节 |
| sha256 | `0562c60cf3c92abd3753a14f53eb3e4a2d83cab975a1f230d6991d138c2b3a96` |
| 拉取时间 | 2026-09-18 |
| 全局导出 | `WorkBuddyCloud`（含 `createWorkBuddyCloud`） |

### 为什么自托管

1. **`@dev` 是不可复现的引用**。线上直接引用滚动标签 = 平台方发新版就自动进生产，
   不经我们部署、不经我们测试。改成固定副本后，升级变成一个**显式动作**。
2. **可达性**：`cdn.jsdelivr.net` 在国内链路实测**时通时不通**
   （2026-09-18 本机连测 3 次全部 `http=000` 快速失败，同时 unpkg 与本站域名均正常）。
   而它加载失败的表现是 `alert('云端组件没加载出来…')` 之后**整个云端功能不可用** ——
   登录都进不去，不只是少个功能。
3. 它是**零内部依赖**的自包含包（无外部 URL、无 `import()`、无 Worker），
   自托管不会出现"内层还依赖别的东西"的半吊子情况。

### 怎么升级

**这是一个需要手动执行的步骤** —— 自托管的代价就在这里。

```bash
# 1. 下载新版（jsdelivr 不通时可换 unpkg，两者内容一致）
curl -sL -o vendor/index.global.js \
  https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js
# 备用源：https://unpkg.com/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js

# 2. 记下新的 sha256 并回填到本文件
sha256sum vendor/index.global.js

# 3. 跑测试（含"不得引入外部 script 域名"的反向断言）
#    _t_local.html / _t_login.html / _t_inc.html

# 4. 部署，并在真机上走一遍 登录 → 绑定 → 同步
```

升级前一并确认这几件事，它们决定"换版本会不会静默坏掉"：

- SDK 仍然导出全局 `WorkBuddyCloud`
- `createWorkBuddyCloud({ publishableKey, endpoint, appId })` 签名没变
  （当前 arity = 1，即单个配置对象）
- `auth` 上的这些方法还在：`signInWithPassword` / `sendOtp` / `verifyOtp` /
  `resetPasswordForEmail` / `updateUser` / `signOut` / `getSession`

快速自检（node，不需要浏览器）：

```bash
node -e "
const fs=require('fs'), vm=require('vm');
const ctx={console, setTimeout, clearTimeout, URL, TextEncoder, AbortController};
ctx.globalThis=ctx; ctx.window=ctx; ctx.self=ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('vendor/index.global.js','utf8'), ctx);
const W=ctx.WorkBuddyCloud;
console.log('导出:', Object.keys(W).length, 'createWorkBuddyCloud:', typeof W.createWorkBuddyCloud);
"
```

### 注意

- **服务端静态白名单是名单制**：`server/config.py` 的 `STATIC_DIRS` 必须包含 `"vendor"`，
  否则线上 404（本地 `file://` 打开不经过服务端，测不出来）。
- 文件末尾保留了一行 `//# sourceMappingURL=index.global.js.map`，指向未一并附带的
  map 文件。**这是有意保留的** —— 去掉它会让文件哈希与官方不一致，失去校验价值。
  代价只是 devtools 里一条无害的 404 警告。
- 本目录**不要**放任何含密钥的东西。这里的内容会随静态资源对外提供。
