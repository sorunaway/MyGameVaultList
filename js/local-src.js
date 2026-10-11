/*
 * 本机数据源（Windows 桌面版）—— 把 `/api/local/*` 接进 DataStore。
 *
 * 为什么单独一个文件：线上版（`cloud.js`，登录 + 云端数据库）还在时，桌面版要的是
 * 「本机 Steam 文件 + 本机浏览器存储」。两条路的数据来源、身份确认、失败处理全不一样，
 * 塞进同一个文件迟早互相绊（那边已经 1600 行量级了）。
 *
 * ⚠️ 线上版 2026-09-28 整体下线、`cloud.js` 已删 —— 本文件里凡是提到 `cloud.js`
 *    的地方都是**历史对照**（写这些守卫/字段时对标的是那份实现），不是在引用一个
 *    还在的文件。那些"为什么这么写"的理由**依然成立**，别当成过时注释删掉。
 *
 * ============================================================
 * 🔴 怎么判断「我正跑在桌面版里」——**问服务端**，不看 URL、不看 hostname
 * ============================================================
 * 只有桌面版启动器（desktop/main.py）会设 `GV_DESKTOP=1`，也只有那时
 * `/api/local/status` 这个路由才存在。于是三种环境各得其所：
 *
 *   · 桌面版            → 200 `{desktop:true}`  → 进桌面模式：数据来自本机 Steam，不显示登录门
 *   · 线上部署          → 404（路由根本不存在）  → 回落到云模式，行为跟以前一模一样
 *   · 双击 index.html   → fetch 直接抛错         → 回落到本地模式（seed-data 那套）
 *     （file:// 下相对路径 fetch 拿不到东西，抛错是预期行为，不是故障）
 *
 * 用服务端判定而不是 `location.hostname === '127.0.0.1'` 这类前端猜测，是因为
 * 前端猜测既能被伪造、又会误伤「本机起了个服务端做调试」的场景。
 *
 * ============================================================
 * ⚠️ 桌面版拿到的数据是**有上限**的（别在 UI 上把它说成全量）
 * ============================================================
 * 只有「本机装过 / 玩过 / 在某收藏夹里」的款才有记录，名字还只有已安装的那些有。
 * 实测：本机约 300 款 / 账号侧约 400 款，其中约九成没名字 —— 这些由下面的 `fillMeta()`
 * 联网分批补（免 key 的商店接口），进度存本机、每次启动接着补。
 */
(function () {
  'use strict';

  // 探测超时：服务端就在本机，正常 <10ms。给 1.5 秒纯粹是防「服务端卡住把整页拖死」。
  var STATUS_TIMEOUT = 1500;
  // 拉库要扫 4 个库目录 + 2000 多个封面目录，给宽一点
  var LIBRARY_TIMEOUT = 30000;
  // 扫盘：后端有三个上限（深度 3 / 4000 目录 / 25 秒），这里比它再宽一截
  var SCAN_TIMEOUT = 45000;

  function getJSON(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var ctl = null, timer = null;
      try {
        ctl = new AbortController();
        timer = setTimeout(function () { ctl.abort(); }, timeoutMs || STATUS_TIMEOUT);
      } catch (e) { /* 没有 AbortController 就不带超时，别因此整个功能不可用 */ }
      var opt = { cache: 'no-store' };
      if (ctl) opt.signal = ctl.signal;
      fetch(url, opt).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (d) {
        if (timer) clearTimeout(timer);
        resolve(d);
      }).catch(function (e) {
        if (timer) clearTimeout(timer);
        reject(e);
      });
    });
  }

  /**
   * POST JSON。**必须带 `Content-Type: application/json`** ——
   * 它会让浏览器先发一个 OPTIONS 预检，服务端不回 CORS 头 → 跨站页面调不通。
   * 这是回环守卫之外的第二道（`_desktop_guard` 才是主防线）。
   */
  function postJSON(url, body, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var ctl = null, timer = null;
      try {
        ctl = new AbortController();
        timer = setTimeout(function () { ctl.abort(); }, timeoutMs || STATUS_TIMEOUT);
      } catch (e) { /* 同上 */ }
      var opt = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        cache: 'no-store'
      };
      if (ctl) opt.signal = ctl.signal;
      fetch(url, opt).then(function (r) {
        // 400 也是**有内容的正经回答**（比如"这个目录不存在"），别当成网络故障吞掉
        return r.json().then(function (d) { return { ok: r.ok, status: r.status, body: d }; },
                             function () { return { ok: r.ok, status: r.status, body: {} }; });
      }).then(function (r) {
        if (timer) clearTimeout(timer);
        resolve(r);
      }).catch(function (e) {
        if (timer) clearTimeout(timer);
        reject(e);
      });
    });
  }

  /**
   * 和 `getJSON` **唯一**的区别：非 2xx 也把 body 交出来（只要它能解析成 JSON）。
   *
   * 🔴 为什么必须有这个变体（2026-09-24）：服务端的失败响应**本身就是说明书正文**——
   *   · `502 {"error":"steam_unreachable","message":"连不上 Steam（跨境链路波动）…"}`
   *   · `200 {"error":"steam_key_rejected","message":…,"howToFix":[…]}`（Key 被拒是**用户
   *     可修**的配置问题，所以故意不是 5xx）
   * 旧的 `getJSON` 遇到 502 直接 `throw new Error('HTTP 502')`，于是 `message` 和
   * `howToFix` **全被吞掉**，用户只能看到一句「本机服务没有响应」——
   * 而真正的原因（链路波动 vs Key 失效）解法完全相反。
   *
   * 判据与 `cloud.js` 的 `apiGet` 同源：`if (!r.ok && !d.error) throw`——
   * 也就是「服务端给了结构化原因就照收，纯 HTTP 错误码才当失败」。
   */
  function getJSONLoose(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var ctl = null, timer = null;
      try {
        ctl = new AbortController();
        timer = setTimeout(function () { ctl.abort(); }, timeoutMs || STATUS_TIMEOUT);
      } catch (e) { /* 同上：没有 AbortController 就不带超时 */ }
      var opt = { cache: 'no-store' };
      if (ctl) opt.signal = ctl.signal;
      fetch(url, opt).then(function (r) {
        return r.json().then(function (d) { return d; },
                             function () { return {}; }).then(function (d) {
          if (!r.ok && !(d && d.error)) throw new Error('HTTP ' + r.status);
          return d;
        });
      }).then(function (d) {
        if (timer) clearTimeout(timer);
        resolve(d);
      }).catch(function (e) {
        if (timer) clearTimeout(timer);
        reject(e);
      });
    });
  }

  /**
   * 探测本机服务。**任何失败都返回 null**（不抛）——
   * 「不是桌面版」是正常情况，不该让调用方写 try/catch。
   */
  function probe(timeoutMs) {
    return getJSON('/api/local/status', timeoutMs).then(function (d) {
      if (!d || !d.desktop) return null;
      // 桌面版里「数据存在哪」这句话要说实话（ui.js 读它渲染页脚）
      window.__gvStorageNote = '数据来自本机 Steam，保存在本机（离线版）';
      return d;
    }).catch(function () { return null; });
  }

  function load() {
    return getJSON('/api/local/library', LIBRARY_TIMEOUT);
  }

  /**
   * 本地库 → `DataStore.mergeSteam` 认的记录形状。
   *
   * 🔴 字段名**照抄 cloud.js 那一套**（appid / title / header / icon /
   *    totalMinutes / recentMinutes / lastPlayedTs / collections）。
   *    别在这里发明新名字 —— mergeSteam 只认这几个，写错了不报错，只是数据静默不生效。
   */
  function toRecords(games) {
    var out = [];
    (games || []).forEach(function (g) {
      if (!g || g.appid == null) return;
      var rec = {
        appid: g.appid,
        title: g.title || '',
        totalMinutes: g.totalMinutes || 0,
        recentMinutes: g.recent2wMinutes || 0,   // 注意改名：2wks → recent
        lastPlayedTs: g.lastPlayedTs || 0,
        collections: Array.isArray(g.collections) ? g.collections.slice() : []
      };
      // 本地封面「有才写」：留空的话，将来联网补商店信息时还有机会把封面落进来；
      // 写成空字符串会把 mergeSteam 里 `src.header || old.header` 那条路堵死。
      if (g.cover) { rec.header = g.cover; rec.icon = g.cover; }
      out.push(rec);
    });
    return out;
  }

  /**
   * 拉本机库并合并进 DataStore。返回 mergeSteam 的统计 + 本次的来源信息。
   * `ok:false` 时带 `reason`：steam_not_found / no_account / fetch_failed / no_datastore。
   */
  async function sync() {
    if (!window.DataStore) return { ok: false, reason: 'no_datastore' };
    var data;
    try {
      data = await load();
    } catch (e) {
      return { ok: false, reason: 'fetch_failed', error: String((e && e.message) || e) };
    }
    if (!data || !data.ok) {
      return { ok: false, reason: (data && data.reason) || 'unknown', steamDir: data && data.steamDir };
    }
    var records = toRecords(data.games);
    var res = await window.DataStore.mergeSteam(records);
    return {
      ok: true,
      total: records.length,
      // `appids` = 这次读到的**本机库全量 appid**，给「修回被错标的愿望单款」当
      // 权威集合用（见 store.js `reclassifyWishlistOnly`）。本地文件读得到 =
      // 这台机器上确实有它 —— 光凭愿望单身份不够，所以这一半也少不得。
      appids: records.map(function (r) { return r.appid; }),
      account: data.account || null,
      stats: data.stats || {},
      added: res.added, updated: res.updated,
      recollected: res.recollected, locked: res.locked, abandoned: res.abandoned
    };
  }

  // ============================================================
  // 补全商店信息（名字 / 封面 / 发售年 / 类型 / 开发商）
  // ============================================================
  // 本机 Steam 文件只对「装过 / 玩过 / 在某收藏夹里」的款有记录，
  // **名字更只有已安装的那些有**（实测本机约 300 款里九成没名字）。
  // 名字只能联网问，走**免 key** 的 `/api/steam/store`（= store.steampowered.com/api/appdetails）。
  //
  // 为什么要「每轮补一批」而不是一次补完：商店接口**一款一次**，几百款要跑好几分钟，
  // 用户会以为卡死。所以进度落在本机（`gv_local_meta_v1`），每次启动接着补 ——
  // 单次时长有上限，中途关掉也不丢进度。这套做法与云端版（`cloud.js` 的 `fillMeta`）一致。
  //
  // ⚠️ **两种「没拿到」必须区分**：
  //   · Steam 明确说查不到（下架 / 锁区）→ 记成「问过了」，不再问；
  //   · 这次没拿到答案（网络 / 限流，后端放在 `unknown` 里）→ **绝不能记**，
  //     否则那款游戏的名字/封面**永远**补不回来。
  var META_KEY = 'gv_local_meta_v1';
  var META_PER_RUN = 45;    // 一轮最多补多少款（**默认值**；手动同步那一次会调大，见 fillMeta）
  var META_BATCH = 15;      // 一次请求带多少款（后端 STORE_MAX_IDS = 30，留一半余量）
  var META_TIMEOUT = 60000; // 后端单请求预算 STORE_DEADLINE = 34 秒，客户端给宽一点
  var META_DOWN_KEY = 'gv_local_meta_down_v1';
  var META_DOWN_TTL = 6 * 3600 * 1000;   // 「链路不通」记住 6 小时

  // 🔴 链路不通时**必须先收手**，否则每次启动都白耗：
  //    商店域名在有些机器上被本地代理 / hosts 拦截（本机实测：直连 0.25 秒被 RST，
  //    走环境代理 SSL EOF），而服务端每批有 34 秒预算 —— 一轮 3 批就是 100 秒的
  //    无效等待 + 一次都不成功。所以「首波全灭」就停，并记下"不通"，6 小时内不再试。
  //    有一批拿到正常答复就立刻清掉这个标记。
  function linkDownAt() {
    try { return Number(window.localStorage.getItem(META_DOWN_KEY)) || 0; }
    catch (e) { return 0; }
  }
  function setLinkDown(ts) {
    try { window.localStorage.setItem(META_DOWN_KEY, String(ts)); } catch (e) {}
  }
  function clearLinkDown() {
    try { window.localStorage.removeItem(META_DOWN_KEY); } catch (e) {}
  }

  function readFetched() {
    try {
      var raw = window.localStorage.getItem(META_KEY);
      var o = raw ? JSON.parse(raw) : {};
      return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch (e) { return {}; }   // 隐私模式 / 存储被禁：当没进度，功能仍可用（只是下次重来）
  }

  function writeFetched(o) {
    try {
      window.localStorage.setItem(META_KEY, JSON.stringify(o));
      return true;
    } catch (e) {
      console.warn('补全进度写不进本机存储（不影响本次已补到的结果）', e);
      return false;
    }
  }

  function yearOf(s) {
    var m = String(s || '').match(/(19|20)\d{2}/);
    return m ? Number(m[0]) : null;
  }

  /**
   * 补一批游戏的名字 / 封面等公共信息，直接落进 `DataStore`（本机存储）。
   *
   * 🔴 **严格只补缺，绝不覆盖已有**：只对「还没有名字」或「还没有封面」的款动手，
   * 且写回时**只带当前缺的那些字段**。理由：本机已有的封面是**离线可用**的本地图，
   * 用商店的远程图去盖它，会让离线版为了看图反而必须联网。
   *
   * `limit` —— 这一次最多补多少款。**默认 `META_PER_RUN`（45）**，
   * 给启动那种"后台慢慢补"的场景用。手动同步那一次由调用方给大值：
   * 用户刚点完「同步」人就在屏幕前等，而愿望单一次能进来几百款 ——
   * 45 一款一款地补，他看到的会是几百张写着「App 12345」的卡，
   * 等于这个功能没接上（cloud.js 那边的成就核算是同一个思路：`ACH_PER_RUN = 240`，
   * 注释写着「一次同步就能覆盖整个库」）。
   * ⚠️ 只是上限，不会硬凑：`want` 里有多少补多少。
   *
   * 返回 `{filled, left}`：`filled` = 这次真的补到内容的款数，
   * `left > 0` = 还有剩的，下次接着补。
   */
  async function fillMeta(appids, limit) {
    if (!window.DataStore) return { filled: 0, left: 0, reason: 'no_datastore' };
    // ⚠️ 判断用 `> 0` 而不是真值：调用方可能传 undefined / null / 0，
    //    三种都该回落到默认值（传 0 不是"一款都不补"的意思）。
    var cap = (limit > 0) ? limit : META_PER_RUN;

    var all = await window.DataStore.all();
    var byId = {};
    (all || []).forEach(function (g) { if (g.appid != null) byId[String(g.appid)] = g; });

    var fetched = readFetched();
    var want = [];
    (appids || []).forEach(function (a) {
      if (a == null) return;
      var k = String(a);
      if (fetched[k]) return;                  // 问过了
      var g = byId[k];
      if (!g) return;                          // 不在库里的不问
      // 🔴 **别的平台不问。** `/api/steam/store` 查的是 Steam 商店，它给的答案只对
      //    默认平台那条记录有效。不挡的话有**两个**后果，都在 2026-10-10 实测到：
      //      ① `mergeMeta` 按 (平台, appid) 定位 → EPIC 记录天然落不进来（这一半已由
      //         那边兜住）；② 但**这一层还在白问**：为一个 EPIC 的 appid 去问 Steam 商店，
      //         白耗一批额度（`META_BATCH` 15 个名额里被占掉）。
      //    真正的重复卡是改动前的 `mergeSteam` 造的（它按裸 appid 在**默认平台**索引里找，
      //    EPIC 记录不在索引里 → 当成新记录又建一条），这里一并把它堵死。
      var P = window.GVPlatforms;
      if (P && P.of(g) !== P.DEFAULT_ID) return;
      // 🔴 「名字和封面都有就跳过」这条守卫**不能拿掉** —— 它是给全库几百款省请求的
      //    （每次启动补一批，没有它每轮都会为整个库重发请求）。
      //
      //    但**手动加的条目要开一个口子**：它的名称来自商店候选、封面是按 appid 拼的
      //    URL，于是"名字和封面都有"这句对它成立 —— 可它**类型 / 开发商 / 发售年
      //    从来没问过**。不开口子，这几项就永远是空的（2026-09-28 实测确认）。
      //    这类条目是用户一款一款手填的，量很小，多问几次不心疼。
      //
      //    补到之后 `mergeSteam` 会写进 `genres`（下面那段就是），所以
      //    「已经有类型」的第二个条件保证它**不会每轮都重问**。
      var manualGap = g.source === 'manual' && !(g.genres || []).length;
      if (!manualGap && g.title && g.header) return;
      want.push(k);
    });
    if (!want.length) return { filled: 0, left: 0 };

    // 上次试过、判定链路不通且还没到期 → 直接跳过（不发任何请求）
    var down = linkDownAt();
    if (down && Date.now() - down < META_DOWN_TTL) {
      return { filled: 0, left: want.length, skipped: 'link_down' };
    }

    var work = want.slice(0, cap);
    var filled = 0, unanswered = 0, attempted = 0;

    for (var i = 0; i < work.length; i += META_BATCH) {
      var part = work.slice(i, i + META_BATCH);
      attempted += part.length;
      var d = null;
      try {
        d = await getJSON('/api/steam/store?appids=' + part.join(','), META_TIMEOUT);
      } catch (e) {
        unanswered += part.length;            // 整批没回来（本机服务没响应）→ 留到下次
        continue;
      }
      var items = (d && d.items) || {};
      var unknown = {};
      ((d && d.unknown) || []).forEach(function (x) { unknown[String(x)] = 1; });

      var recs = [];
      var answered = 0;
      part.forEach(function (k) {
        if (unknown[k]) { unanswered++; return; }   // 没拿到答案 → 不记进度
        answered++;
        fetched[k] = 1;                             // 走到这儿都是「确定答复」
        var v = items[k];
        if (!v) return;                             // Steam 明说查不到：记进度，不写任何字段
        var g = byId[k] || {};
        var rec = { appid: Number(k) };
        if (!g.title && v.name) rec.title = v.name;
        if (!g.header && v.header) rec.header = v.header;
        if (!g.releaseDate && v.release) rec.releaseDate = v.release;
        if (!g.releaseYear) {
          var yr = yearOf(v.release);
          if (yr) rec.releaseYear = yr;
        }
        if ((!g.genres || !g.genres.length) && v.genres && v.genres.length) rec.genres = v.genres;
        if ((!g.developers || !g.developers.length) && v.developers && v.developers.length) {
          rec.developers = v.developers;
        }
        if (Object.keys(rec).length > 1) { recs.push(rec); filled++; }
      });

      if (recs.length) {
        // 🔴🔴 **必须走 `mergeMeta`，绝不许退回 `mergeSteam`。**
        //    这条路径只知道"这款在商店里叫什么、哪年出的"，**一点拥有凭证都没有**；
        //    而 `mergeSteam` 对已存在的记录会无条件 `old.source = 'steam'`
        //    （只保护 family）→ 愿望单里的款会被顺手"转正"成「已拥有」。
        //    2026-10-10 用户实测投诉的就是这个：库里多出一批假「已拥有」，
        //    全部来自这里（愿望单接口不给名字 → 它们正是本函数补得最凶的一批）。
        //    细节见 store.js `mergeMeta` 的说明。
        try { await window.DataStore.mergeMeta(recs); }
        catch (e) { console.warn('写回商店信息失败（进度照记）', e); }
      }
      writeFetched(fetched);   // 每批都落盘：中途关掉也不丢进度

      if (!answered) {
        // 🔴 整批一个确定答复都没有 ⇒ 是链路层不通（限流会带 429，这里连状态码都没有）。
        //    别接着把剩下的批跑完 —— 那是纯粹的白等。
        setLinkDown(Date.now());
        break;
      }
      clearLinkDown();   // 通了：把上次留下的"不通"标记清掉
    }

    return {
      filled: filled,
      left: Math.max(0, want.length - attempted) + unanswered
    };
  }

  // ============================================================
  // 联网同步（可选，需要 SteamID + Web API Key）
  // ============================================================
  // 为什么要有这条路 —— 它补的是本机文件**结构上看不到**的那部分：
  //   本机 Steam 文件只记录「装过 / 玩过 / 在某个收藏夹里」的款（本机约 300 款），
  //   而 Steam 账号侧有全量（约 400 款）。差的那些是「买了但一次都没碰过」的。
  //
  // 🔴 两条"绝不能做"，每一条都能静默毁掉用户已有的数据：
  //
  //   ① **绝不能带 `collections`**。`mergeSteam` 对它是
  //      `if (Array.isArray(src.collections)) old.collections = src.collections`
  //      —— 带了就**无条件覆盖**；而 Steam 的库接口**给不出收藏夹**（它只回
  //      游戏/时长/图标），于是"联网同步"会把「完结撒花」「已隐藏」全清成空数组，
  //      数十款「已通关」当场掉回「正在游玩/已暂停」。
  //      ⇒ 收藏夹永远只由**本机那次同步**写（它读的是 cloud-storage 文件）。
  //      ⇒ 因此顺序也不能反：**先本机、再联网**。
  //
  //   ② **绝不能带 `header`**。本机封面是离线可用的本地图（`/api/local/cover`），
  //      而联网记录里根本没有封面字段 —— 一旦带上一个空串/别的 URL，
  //      就会把「不联网也能看到的图」换掉或堵死（`src.header || old.header`）。
  //      新进来的款没有封面是正常的，交给 `fillMeta` 按部就班补。
  var ONLINE_LIB_TIMEOUT = 60000;   // 服务端 LIB_TOTAL_BUDGET 42s + 昵称 6s，客户端给宽一点

  /**
   * 联网读全量库并合并。返回 `{ok, ...}`；失败时带 `reason` + 可执行指引。
   *
   * `reason` 取值：no_datastore / no_steamid / fetch_failed / bad_response /
   *                no_key / profile_private / steam_unreachable / empty
   */
  async function syncOnline(steamid) {
    if (!window.DataStore) return { ok: false, reason: 'no_datastore' };
    var sid = String(steamid == null ? '' : steamid).trim();
    if (!/^\d{17}$/.test(sid)) return { ok: false, reason: 'no_steamid' };

    // 合并前拍快照：用来判「哪些是这次新进来的」（新进来的没有本机封面，值得优先补图）
    var before = [];
    try { before = await window.DataStore.all(); } catch (e) { console.warn('读旧数据失败', e); }
    var prev = {};
    (before || []).forEach(function (g) { if (g.appid != null) prev[String(g.appid)] = g; });

    var d = null;
    try {
      d = await getJSON('/api/steam/library?steamid=' + encodeURIComponent(sid),
                        ONLINE_LIB_TIMEOUT);
    } catch (e) {
      return { ok: false, reason: 'fetch_failed', error: String((e && e.message) || e) };
    }
    if (!d) return { ok: false, reason: 'bad_response' };
    if (d.error) {
      // 服务端把「为什么读不到」和「怎么修」都给了 —— 原样透上去，别在这儿改写文案
      return { ok: false, reason: d.error, message: d.message || '',
               howToFix: d.howToFix || [], stale: !!d.stale };
    }

    var games = d.games || [];
    if (!games.length) return { ok: false, reason: 'empty' };

    var newIds = [];
    var recs = games.map(function (g) {
      if (!g || g.appid == null) return null;
      var k = String(g.appid);
      var fresh = !prev[k];
      if (fresh) newIds.push(g.appid);
      return {
        appid: g.appid,
        title: g.title || '',
        icon: g.icon || '',
        totalMinutes: g.totalMinutes || 0,
        recentMinutes: g.recentMinutes || 0,
        lastPlayedTs: g.lastPlayedTs || 0
        // ⚠️ 这里**故意**不写 collections / header / achievements —— 见本段开头那两条。
      };
    }).filter(Boolean);

    var res = await window.DataStore.mergeSteam(recs);
    return {
      ok: true,
      total: recs.length,
      newIds: newIds,
      // `appids` = 这次账号侧全量库的 appid（**权威**的"我确实买了"名单）。
      // 给「修回被错标的愿望单款」用 —— 见 store.js `reclassifyWishlistOnly`。
      appids: recs.map(function (r) { return r.appid; }),
      added: res.added, updated: res.updated,
      recollected: res.recollected, locked: res.locked, abandoned: res.abandoned,
      stale: !!d.stale,
      // stale 的两种原因解法相反：keyRejected=true 要**去换 Key**，
      // 否则等一会儿再同步就好。透传上去让状态行能说对方向。
      keyRejected: !!d.keyRejected,
      staleMessage: d.message || '',
      namesOk: d.namesOk !== false
    };
  }

  // ============================================================
  // Steam 愿望单（「愿望单 -> 待游玩」）—— 桌面版
  // ============================================================
  //
  // 🔴 为什么必须有这段（2026-09-24，用户实测投诉）：
  //    「绑定了 STEAMID 以及新的 KEY，并且同步完成后，愿望单功能没有像预期
  //      那样工作，『待游玩项目』始终为 0」。
  //    根因不是接口坏了、也不是数据层坏了 —— 是**桌面版这条路从来没调过它**：
  //    `DS.mergeWishlist` 与 `/api/steam/wishlist` 都写好了，但唯一的调用点在
  //    `cloud.js` 的 `syncNow`（浏览器 / 云端路径）。桌面版的同步入口是
  //    `ui.js` 的 `syncDesktop`，它只有 ① 本机 ② 联网 ③ 家庭库三步 ——
  //    于是桌面版**一次都没有拉过愿望单**，`status='backlog'` 的记录一条都建不出来，
  //    「待游玩」永远是 0，且没有任何报错（静默缺失，最难查的那种）。
  //
  // ⚠️ 与 `cloud.js` 那边是**两份实现、一套语义**，故意不共用：
  //    这条走本机服务的 `/api/steam/wishlist`（无登录态、读本机 desktop.json 里的 Key），
  //    那条走云端 API + 云端登录态。数据源 / 身份确认 / 超时全都不同，
  //    硬合并会两边互相绊。但返回形状**逐字一致**，且下面那条守卫必须一模一样。
  var WISH_TIMEOUT = 30000;   // 服务端 WISH_BUDGET（出网预算）+ 回环余量

  /**
   * 拉一次 Steam 愿望单并合并进本地库。
   *
   * 返回 `{ok:true, count, added, removed, kept, appids}`，
   * 或 `{ok:false, reason, message, howToFix, steamPrivacyUrl, steamKeyUrl}`。
   * 调用方**不需要**在失败时做任何补偿 —— 这个函数自己保证失败即无副作用。
   *
   * `reason` 取值：no_datastore / no_steamid / fetch_failed / bad_response /
   *                unavailable / empty / steam_key_rejected / steam_unreachable
   *
   * ## 🔴 空列表守卫（整个功能里最要紧的一段，与 cloud.js 那份同源）
   *
   * `DS.mergeWishlist` 会把「本地有、这次没返回」的款判定成「你把它从愿望单
   * 删掉了」，删掉记录。而下面这两种情况返回的东西**完全一样**：
   *   · 愿望单真的空了
   *   · 隐私设置没公开（Steam 对空和未公开给的是同一份 `{"response":{}}`）
   * 一次误判就是几百条记录没了，且不可恢复。所以：
   *   · 接口失败 / 状态不可用 / 结果为空  -> **一律不调 mergeWishlist**，什么都不做
   * 宁可这次不导入，也不能猜。
   */
  async function syncWishlist(steamid) {
    if (!window.DataStore) return { ok: false, reason: 'no_datastore' };
    var sid = String(steamid == null ? '' : steamid).trim();
    if (!/^\d{17}$/.test(sid)) return { ok: false, reason: 'no_steamid' };

    var d = null;
    try {
      // ⚠️ 用 getJSONLoose：502（steam_unreachable）的 message 就在 body 里，
      //    用 getJSON 会被 throw 吞掉，只剩一句"本机服务没有响应"（指错方向）。
      d = await getJSONLoose('/api/steam/wishlist?steamid=' + encodeURIComponent(sid),
                             WISH_TIMEOUT);
    } catch (e) {
      return { ok: false, reason: 'fetch_failed',
               message: '愿望单这次没拉到（本机服务没有响应），下次同步会自动重来。' };
    }
    if (!d) return { ok: false, reason: 'bad_response' };
    if (d.error) {
      // 服务端把「为什么读不到」和「怎么修」都给了 —— 原样透上去，别在这儿改写文案。
      // 缺 Key / Key 被拒 / 链路不通 是**三种**不同的原因，解法各不相同。
      return { ok: false, reason: d.error, message: d.message || '',
               howToFix: d.howToFix || [], steamKeyUrl: d.steamKeyUrl || '' };
    }
    if (d.state === 'unavailable') {
      // 「愿望单是空的」和「愿望单没公开」Steam 给的是同一份数据，分不开 ——
      // 文案要把两种可能都写上（服务端已经写好，原样用）。
      return { ok: false, reason: 'unavailable', message: d.message || '',
               howToFix: d.howToFix || [], steamPrivacyUrl: d.steamPrivacyUrl || '' };
    }

    var items = (d.items || []).filter(function (x) { return x && x.appid; });
    if (!items.length) {
      return { ok: false, reason: 'empty',
               message: '愿望单这次返回的是空的，已跳过（不做任何删除）。' };
    }

    var stat = await window.DataStore.mergeWishlist(items);
    return {
      ok: true,
      count: items.length,
      added: stat.added,
      removed: stat.removed,
      kept: stat.kept,
      appids: items.map(function (x) { return x.appid; })
    };
  }

  // ============================================================
  // Steam 成就进度（「全成就 -> 已通关」）—— 桌面版
  // ============================================================
  //
  // 🔴 为什么必须有这段（2026-09-29 排查时发现）：
  //    `/api/steam/achievements`（并发分波 + 9 类失败判据 + `no_stats` 确定性答案）
  //    在服务端**一直是活的**，但桌面版这条路**从来没调过它** —— 唯一的调用点是
  //    （2026-09-28 随线上版一起删掉的）云端路径里的 `scanAchievements`。
  //    于是 `game.achievements` 恒为 `null`，四个后果全是**静默**的、一个报错都没有：
  //      · 顶栏统计格「全成就」恒 0        （`ui.js` 的 renderStats）
  //      · 卡片永不挂全成就勋章            （`store.js` 的 isPerfect）
  //      · `suggestStatus()` 第 3 条「全成就 -> 已通关」永不命中
  //      · 排序「成就进度」永远全垫底
  //    ⚠️ 与 2026-09-24 愿望单那次是**同一类缺陷**（能力写好了、桌面版的入口没接）——
  //       愿望单补了，成就漏了。诊断口径也一样：先数"谁调用了这个接口"。
  //
  // 🔴 每轮只核一批（`ACH_BATCH` 款），从没核过的优先 —— 这就是「每轮同步真的
  //    往前推进」：全库几百款要分几次核完，而不是一次把同步卡死几分钟。
  //    候选池 = 我的 Steam 记录里 `totalMinutes > 0` 且**还没有 `achievements`** 的款。
  //    核过就落库（包括 `{0,0}` —— 那是"这款没有成就系统"的**确定性答案**），
  //    于是候选池自然枯竭，不会每轮重复轰炸 Steam。
  //
  // ⚠️ **已知限制（不是设计）**：核过的款不再刷新 —— 只有"从没核过"才进候选池。
  //    所以「本来没全成就、后来打全了」不会被自动发现（要重核得先清掉那条的
  //    `achievements`）。做成"按时间戳定期重扫"要新加一个字段，属独立改动。
  var ACH_BATCH = 120;        // = 服务端 `ACH_MAX_IDS`（一次最多问这么多）
  var ACH_TIMEOUT = 40000;    // 服务端 ACH_DEADLINE 34s + 回环余量

  /**
   * 取一批成就进度并合并进本地库。
   *
   * 返回 `{ok:true, asked, got, left, recollected, link, fatal}`，
   * 或 `{ok:true, nothingToDo:true, left:0}`（候选池空了，这一步本轮跳过），
   * 或 `{ok:false, reason, message, howToFix, link, reasons, left}`。
   *
   * `left > 0` = 还有没核的，下次同步接着来。
   *
   * `reason` 取值：no_datastore / no_steamid / fetch_failed / bad_response /
   *                链路类（steam_unreachable / steam_key_rejected / no_key…）。
   * ⚠️ 调用方**不需要**在失败时做任何补偿 —— 这个函数自己保证失败即无副作用。
   */
  async function syncAchievements(steamid) {
    if (!window.DataStore) return { ok: false, reason: 'no_datastore' };
    var sid = String(steamid == null ? '' : steamid).trim();
    if (!/^\d{17}$/.test(sid)) return { ok: false, reason: 'no_steamid' };

    // ---- 候选池 ----
    // 🔴 三条筛选缺一不可：
    //   ① **只在我自己的 Steam 库里**。排掉 `wishlist` / `family` 与别的平台：
    //      `mergeSteam` 对喂进去的记录会写 `old.source = 'steam'` —— 愿望单里的款
    //      被顺手"转正"就等于凭空多出一堆「已拥有」（`store.js` 那段注释钉着这条）。
    //   ② `totalMinutes > 0`。一次都没启动过的款没有成就可言（`scripts/sync.py`
    //      同口径："只查玩过的"）。
    //   ③ 还没有 `achievements`。核过的不重复核（见上面「每轮推进」）。
    var all = [];
    try {
      all = await window.DataStore.all();
    } catch (e) {
      return { ok: false, reason: 'no_datastore' };
    }
    var P = window.GVPlatforms;
    var cand = (all || []).filter(function (g) {
      if (!g || g.appid == null) return false;
      if (P && P.of(g) !== P.DEFAULT_ID) return false;
      if (g.source === 'wishlist' || g.source === 'family') return false;
      if (!(g.totalMinutes > 0)) return false;
      return !g.achievements;
    });

    if (!cand.length) {
      // 候选池空了 —— 这一步本轮**跳过**，不是失败。返回 `nothingToDo` 让调用方
      // 能把"成就是最新的"如实写进明细，而不是留一行空白让人以为漏了。
      return { ok: true, nothingToDo: true, asked: 0, got: 0, left: 0 };
    }

    // 从没核过的优先（上面的筛选已保证），组内按**游玩时长降序** ——
    // 玩得多的更可能是用户真正在意的那几款，先让它们在界面上出结果
    // （勋章 / 自动进「已通关」），比按 appid 顺序扫更早看到东西。
    cand.sort(function (a, b) { return (b.totalMinutes || 0) - (a.totalMinutes || 0); });
    var ids = cand.slice(0, ACH_BATCH).map(function (g) { return g.appid; });

    var d = null;
    try {
      // ⚠️ 用 getJSONLoose：链路类失败（502）的 message 在 body 里，
      //    用 getJSON 会被 throw 吞掉、只剩一句"本机服务没有响应"（指错方向）。
      d = await getJSONLoose('/api/steam/achievements?steamid=' + encodeURIComponent(sid) +
                             '&appids=' + ids.join(','), ACH_TIMEOUT);
    } catch (e) {
      return { ok: false, reason: 'fetch_failed',
               message: '成就这次没拉到（本机服务没有响应），下次同步会接着核。',
               left: cand.length };
    }
    if (!d) return { ok: false, reason: 'bad_response', left: cand.length };
    if (d.error) {
      // 服务端把「为什么读不到 + 怎么修」都给了 —— 原样透上去，别在这儿改写文案。
      return { ok: false, reason: d.error, message: d.message || '',
               howToFix: d.howToFix || [], left: cand.length };
    }

    // ---- 落库 ----
    // 🔴 契约：`items[appid] === null` = **不知道**（这次没轮到 / 查询失败）——
    //    这种情况**一个字都不许写**。写了就等于把"不确定"记成"已核过"，
    //    而那款**永远不会再被核**（候选池只挑没有 `achievements` 的）。
    //    这是本段最容易写错的一行，服务端 `_api_achievements` 的注释也钉着它。
    var res = d.items || {};
    var recs = [];
    ids.forEach(function (id) {
      var a = res[String(id)];
      if (!a) return;
      var earned = Number(a.earned), total = Number(a.total);
      if (!isFinite(earned) || !isFinite(total)) return;
      recs.push({ appid: id, achievements: { earned: earned, total: total } });
    });

    if (!recs.length) {
      // 一款都没拿到答案。**不报成"已核 0 款"** —— 那读起来像"这些游戏都没成就"，
      // 而真相是"这次一个都没问到"。原因分类服务端已经给了（`link` / `fatal`）。
      return { ok: false, reason: d.fatal || 'steam_unreachable',
               link: d.link || '', reasons: d.reasons || {}, left: cand.length };
    }

    var stat = await window.DataStore.mergeSteam(recs);
    return {
      ok: true,
      asked: ids.length,
      got: recs.length,
      // 没拿到答案的那几款仍在候选池里，所以"还剩"按**候选总数 - 拿到的**算，
      // 而不是 asked - got 之后再减 —— 写错会让进度条永远差一截。
      left: Math.max(0, cand.length - recs.length),
      recollected: stat.recollected || 0,   // 被「全成就」拉进「已通关」的款数
      link: d.link || 'ok',
      fatal: d.fatal || ''
    };
  }

  // ============================================================
  // 商店搜索（按名字找 AppID）—— 给「手动添加游戏」当联想
  // ============================================================
  //
  // ⚠️ 与 cloud.js 那边同样是**两份实现、一套语义**（理由同 syncWishlist）：
  //    这条走本机服务的 `/api/steam/search`（无登录态），那条走同一个路径
  //    但带云端登录态。**返回形状逐字一致**，所以 ui.js 只按「有没有后端」
  //    分派，不用关心是哪一边在答。

  var SEARCH_TIMEOUT = 12000;   // 服务端出网超时 8s × 重试 + 回环余量

  /**
   * 按名字搜 Steam 商店，拿候选（最多 10 条 —— 上限在 Steam 那边，不是我们截的）。
   *
   * 返回 `{ok:true, items:[{appid, name, tiny}]}`
   * 或 `{ok:false, reason, message, items:[]}`。
   * `reason` 取值：empty / fetch_failed / bad_response / term_empty /
   *                term_too_long / steam_unreachable
   *
   * 🔴 **它是只读的，绝不改变「拥有」语义。**
   *    不写存储、不碰任何游戏记录 —— 返回的 appid 只是交给表单填一下，
   *    好让用户点「添加」之后能顺手抓到封面。搜到 ≠ 你有这款。
   *
   * 🔴 「搜到 0 条」和「没搜成」在返回值里必须分得开
   *    （`ok:true, items:[]` 对 `ok:false`）：前者该说「没找到」，
   *    后者该说「这次没连上，再试试」。混成一句，用户会以为是自己名字打错了，
   *    然后一直改字 —— 和愿望单那条是同一类错误（见 syncWishlist 的说明）。
   */
  async function searchApps(term) {
    var t = String(term == null ? '' : term).trim();
    if (!t) return { ok: false, reason: 'empty', items: [] };

    var d = null;
    try {
      // ⚠️ 用 getJSONLoose：502（steam_unreachable）的 message 就在 body 里，
      //    用 getJSON 会被 throw 吞掉，只剩一句"本机服务没有响应"（指错方向）。
      d = await getJSONLoose('/api/steam/search?term=' + encodeURIComponent(t),
                             SEARCH_TIMEOUT);
    } catch (e) {
      return { ok: false, reason: 'fetch_failed', items: [],
               message: '本机服务没有响应' };
    }
    if (!d) return { ok: false, reason: 'bad_response', items: [] };
    if (d.error) {
      // 服务端已经把「为什么没搜成」写好了（含 502 那句链路说明）—— 原样透上去，
      // 别在这儿改写文案：改写了就和服务端说的不是一回事。
      return { ok: false, reason: d.error, message: d.message || '', items: [] };
    }
    return { ok: true, items: d.items || [] };
  }

  // ============================================================
  // 家庭库（Steam Families）—— 桌面版专有，必须联网
  // ============================================================
  //
  // 为什么要有这条路：需求是「能不能拿到家庭库里的游戏」。实测结论是 ——
  // **Steam 的 Web API 里没有任何家庭接口**（`ISteamWebAPIUtil/GetSupportedAPIList`
  // 拉全量清单 54 个接口，一个 family 都没有），`ISteamUser/CheckAppOwnership`
  // 用普通 key 一律 403（它只对发行商 key 开）。
  // 唯一可行的做法是绕一圈：
  //
  //   ① 本机 `localconfig.vdf` 的 `FamilyGroup` 块给**成员名单**
  //      （→ 服务端 `GET /api/local/family`）；
  //   ② 对**每个成员**调 `GetOwnedGames`（它对任何 steamid 都有效，
  //      只要对方把「游戏详情」设为公开）；
  //   ③ 取并集 = 家庭库的**上界**。
  //
  // 🔴 三条必须记住的约束：
  //
  //   ① **只在桌面版成立** —— 成员名单要从本机 Steam 文件读，网页版永远拿不到。
  //      所以这个函数只在桌面态被调用（`ui.js` 的 `syncDesktop`）。
  //   ② **它只是「上界」** —— Steam Families 有不可共享的项（发行商关闭共享、
  //      需要第三方 key 的游戏、被 VAC 封禁的账号等）。所以"家人在这个并集里"
  //      **≠「你一定能玩」** —— 对外文案只能说"家人拥有这些"，不能说"你能玩这些"。
  //   ③ **成员资料私密 → 那一份拿不到**，必须**逐人报出来**，绝不能静默少算
  //      （用户看到"近千款"却不知道少了谁，比看到"5 位读到、1 位没读到"更糟）。
  //
  // 与「我自己那份」的关系：**家庭并集只做加法**。我库里已有的 appid，
  // `mergeFamily` 一律不碰（连标记都不写）—— 见 store.js 里那个函数的注释。
  var FAMILY_MEMBER_TIMEOUT = 60000;   // 单个成员一份库；服务端 LIB_TOTAL_BUDGET 42s + 昵称，给宽一点
  var FAMILY_LIST_TIMEOUT = 15000;     // 读成员名单（纯本机文件解析，不该慢）
  // 一次家庭同步最多花多久。5~6 人的家庭、每人跨境拉一份库，最坏情况会叠到几分钟，
  // 中间还会撞上 Steam 的 1 请求/秒节流 —— 不给上限的话用户会以为卡死。
  // 超预算就收手，并把"还有几位没读完"如实报出来（下次点同步有服务端缓存，通常很快）。
  var FAMILY_TOTAL_BUDGET = 240000;

  /** 读本机家庭组成员名单。没家庭组 → `{ok:false, reason:'no_family'}`（正常状态，不是错误） */
  function loadFamily() {
    return getJSON('/api/local/family', FAMILY_LIST_TIMEOUT);
  }

  /**
   * 拉家庭库并合并。返回：
   *
   *     { ok, total, added, skipped, readable, requested, stoppedEarly,
   *       group:{groupid,name}, members:[{steamId,name,count,reason,message}] }
   *
   * `ok:false` 时带 `reason`：no_datastore / fetch_failed / no_family /
   *                            no_members / all_unreadable。
   * `onProgress(done, total, name)` 用来在状态行上显示"正在读第几个人"。
   */
  async function syncFamily(onProgress) {
    if (!window.DataStore) return { ok: false, reason: 'no_datastore' };

    var fam;
    try {
      fam = await loadFamily();
    } catch (e) {
      return { ok: false, reason: 'fetch_failed', error: String((e && e.message) || e) };
    }
    if (!fam || !fam.ok) {
      return { ok: false, reason: (fam && fam.reason) || 'no_family',
               message: (fam && fam.hint) || '' };
    }

    // 只读**别人**的库 —— 我自己那份走的是 syncOnline，两边的语义完全不同
    // （那份是我的、要写 totalMinutes；家庭成员那份只是"谁也有这款"）。
    var others = (fam.members || []).filter(function (m) {
      return m && !m.isMe && /^\d{17}$/.test(String(m.steamId || ''));
    });
    if (!others.length) return { ok: false, reason: 'no_members' };

    var byAppid = {};       // appid(str) -> 记录（同一款被多人拥有时合并成一条）
    var order = [];
    var rows = [];
    var readable = 0;
    var stoppedEarly = false;
    var t0 = Date.now();

    for (var i = 0; i < others.length; i++) {
      var m = others[i];
      var sid = String(m.steamId);
      var row = { steamId: sid, accountid: String(m.accountid || ''),
                  name: '', count: 0, reason: '', message: '' };

      if (Date.now() - t0 > FAMILY_TOTAL_BUDGET) {
        // 超预算：**如实记成"没读完"**，不要假装这位兄弟没有游戏
        stoppedEarly = true;
        row.reason = 'budget';
        row.message = '这次同步时间用完了，还没读到这一位';
        rows.push(row);
        continue;
      }
      if (onProgress) { try { onProgress(i + 1, others.length, row.name); } catch (e) {} }

      var d = null;
      try {
        d = await getJSON('/api/steam/library?steamid=' + encodeURIComponent(sid),
                          FAMILY_MEMBER_TIMEOUT);
      } catch (e) {
        row.reason = 'fetch_failed';
        row.message = '本机服务没有响应（' + ((e && e.message) || e) + '）';
        rows.push(row);
        continue;
      }
      if (!d) { row.reason = 'bad_response'; row.message = '返回内容看不懂'; rows.push(row); continue; }
      if (d.error) {
        // 资料不公开 / 没 key / 链路不通 —— 服务端的 message 更具体，原样透上去
        row.reason = d.error;
        row.message = d.message || '';
        if (d.player && d.player.name) row.name = d.player.name;
        rows.push(row);
        continue;
      }

      var games = d.games || [];
      if (d.player && d.player.name) row.name = d.player.name;
      if (!games.length) {
        // 空库有两种可能：真的没有游戏，或「游戏详情」没公开（Steam 两种情况
        // 都返回空数组，接口本身分不出来）→ 措辞要覆盖两者，别写死"你没有游戏"。
        row.reason = 'empty';
        row.message = '这位的库是空的 —— 可能他真没买过，也可能他的「游戏详情」没设为公开';
        rows.push(row);
        continue;
      }

      readable++;
      row.count = games.length;
      var label = row.name || ('账号 …' + sid.slice(-4));
      games.forEach(function (g) {
        if (!g || g.appid == null) return;
        var k = String(g.appid);
        var rec = byAppid[k];
        if (!rec) {
          rec = byAppid[k] = { appid: g.appid, title: '', icon: '',
                               familyMinutes: 0, familyOwners: [] };
          order.push(k);
        }
        // 名字/图标「有才写」：降级路径下 Steam 不给名称，写空串会盖掉别人已存的真名字
        if (!rec.title && g.title) rec.title = g.title;
        if (!rec.icon && g.icon) rec.icon = g.icon;
        // 家人时长取**最久的那个**（存在独立字段，绝不并进 totalMinutes）
        if ((g.totalMinutes || 0) > rec.familyMinutes) rec.familyMinutes = g.totalMinutes || 0;
        if (!rec.familyOwners.some(function (o) { return o.steamId === sid; })) {
          rec.familyOwners.push({ name: label, steamId: sid });
        }
      });
      rows.push(row);
    }

    var recs = order.map(function (k) { return byAppid[k]; });
    var res = { added: 0, skipped: 0 };
    if (recs.length) {
      try {
        res = await window.DataStore.mergeFamily(recs);
      } catch (e) {
        console.warn('mergeFamily 失败', e);
      }
    }

    return {
      ok: readable > 0,
      reason: readable > 0 ? '' : 'all_unreadable',
      total: recs.length,
      added: res.added || 0,
      skipped: res.skipped || 0,
      readable: readable,
      requested: others.length,
      stoppedEarly: stoppedEarly,
      group: (fam && fam.group) || {},
      members: rows
    };
  }

  /**
   * 统一的设置写入。**返回形状统一成 `{ok, reason, data}`** ——
   * 调用方不该去分辨"这是 HTTP 400 还是网络断了"，两种都是"没设成"，
   * 区别只在给用户看的原因。
   */
  function saveSettings(body) {
    return postJSON('/api/local/settings', body, 10000)
      .then(function (r) {
        var b = r.body || {};
        return { ok: !!b.ok, reason: b.reason || b.message || '', data: b };
      })
      .catch(function (e) {
        return { ok: false, reason: '本机服务没有响应（' + ((e && e.message) || e) + '）',
                 data: null };
      });
  }

  window.GVLocal = {
    probe: probe,
    load: load,
    toRecords: toRecords,
    sync: sync,

    // ---- 联网补全名字 / 封面（免 key 的商店接口）----
    fillMeta: fillMeta,
    /** 已经问过的款数（排查"为什么它一直在补"时看这个） */
    fetchedCount: function () { return Object.keys(readFetched()).length; },
    /** 「缺名字或缺封面、且还没问过」的款数 —— 即还需要补多少（不发起请求，纯本地判断） */
    pendingCount: async function () {
      if (!window.DataStore) return 0;
      var all = await window.DataStore.all();
      var fetched = readFetched();
      return (all || []).filter(function (g) {
        return g.appid != null && !fetched[String(g.appid)] && !(g.title && g.header);
      }).length;
    },

    /**
     * 按名字搜商店，拿候选（最多 10 条）。
     * 给「手动添加游戏」当联想用 —— **只读公共数据，不碰「拥有」语义**。
     */
    searchApps: searchApps,

    // ---- Steam 目录（哪台机器上 Steam 装在哪都可能不一样）----
    status: function () { return getJSON('/api/local/status', STATUS_TIMEOUT); },
    probePath: function (p) {
      return getJSON('/api/local/probe?path=' + encodeURIComponent(p || ''), 8000);
    },
    scan: function () { return getJSON('/api/local/scan', SCAN_TIMEOUT); },
    /**
     * 存目录。**返回形状统一成 `{ok, reason, data}`** ——
     * 调用方不该去分辨"这是 HTTP 400 还是网络断了"，两种都是"没设成"，
     * 区别只在给用户看的原因。
     */
    setSteamDir: function (p) {
      return saveSettings({ steamDir: p || '' });
    },

    // ---- Steam 账号 / API Key（联网同步用，可选）----
    /**
     * 存凭证。传空串 = 清掉那一项；不传的项 = 不动。
     * 只写本机 `desktop.json`，不上传、不进日志。
     */
    setCredentials: function (steamId, apiKey) {
      var body = {};
      if (steamId !== undefined) body.steamId = steamId || '';
      if (apiKey !== undefined) body.steamApiKey = apiKey || '';
      if (!Object.keys(body).length) {
        return Promise.resolve({ ok: false, reason: '没有要改的字段', data: null });
      }
      return saveSettings(body);
    },

    /**
     * 把用户填的东西解析成 SteamID64。支持：
     *   17 位数字 / `steamcommunity.com/profiles/765...` / `/id/<个性网址>` / 个性网址本身。
     * ⚠️ 个性网址那两种要联网问 Steam，所以「验证」这一步顺便也验了 key 通不通。
     */
    resolveSteamId: function (q) {
      return getJSON('/api/steam/resolve?q=' + encodeURIComponent(q || ''), 20000);
    },

    /**
     * 真问一次 Steam，验「**现在这把 Key** 认不认」。
     *
     * 🔴 为什么要单独一个接口（2026-09-24）：上面的 resolveSteamId 只在填
     *    **个性网址 / 资料链接**时才联网 —— 填 17 位数字 ID 时它一个请求都不发。
     *    而绝大多数人填的就是数字 ID，于是「验证并保存」从来没真的验证过 Key，
     *    用户以为验过了，等点同步才失败，而那时的报错又指向"网络"。
     *
     * 返回三态，调用方必须分开处理：
     *     {ok: true,  player}            Key 有效（顺带可能有账号资料）
     *     {ok: false, message, howToFix} Key 被 Steam 拒绝 —— 跟 howToFix 走
     *     {ok: null,  message, kind}     这次没问到（网络）—— **没测出来**，
     *                                    ⚠️ 绝不能当成"Key 不对"，那会让人白换一把
     */
    verifyKey: function (steamid) {
      var q = steamid ? ('?steamid=' + encodeURIComponent(steamid)) : '';
      return getJSON('/api/steam/verify-key' + q, 20000);
    },

    // ---- 联网同步全量库（需要上面那两个）----
    syncOnline: syncOnline,

    /**
     * 拉一次 Steam 愿望单并合并进本地库（愿望单 -> 待游玩）。
     *
     * ⚠️ 它是**桌面版这条路唯一的入口**：`syncDesktop` 不调它、这个功能就不存在
     * （2026-09-24 之前正是这样，「待游玩」永远是 0）。
     */
    syncWishlist: syncWishlist,

    /**
     * 核一批成就进度（全成就 -> 已通关）。
     *
     * ⚠️ 它同样是**桌面版这条路唯一的入口**：`syncDesktop` 不调它、这个功能就不存在
     * （2026-09-28 之前正是这样 —— 唯一调用点随云端路径一起被删掉了，
     * 「全成就」恒 0、卡片永不挂勋章、自动进「已通关」永不触发，且**没有任何报错**）。
     *
     * 每轮只核 `ACH_BATCH` 款、从没核过的优先 —— 全库几百款要分几次核完。
     * 返回里的 `left > 0` 就是"还剩多少款没核"，调用方要把它说到用户看得见的地方。
     */
    syncAchievements: syncAchievements,

    /** 成就每轮最多核多少款（= 服务端上限）—— 测试与排查时看这个 */
    ACH_BATCH: ACH_BATCH,

    // ---- 家庭库（桌面版专有：成员名单在本机文件里）----
    loadFamily: loadFamily,
    syncFamily: syncFamily,
    /** 家庭同步的单次总预算（毫秒）—— 测试与排查时看这个 */
    FAMILY_TOTAL_BUDGET: FAMILY_TOTAL_BUDGET
  };
})();
