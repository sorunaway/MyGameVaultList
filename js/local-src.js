/*
 * 本机数据源（Windows 桌面版）—— 把 `/api/local/*` 接进 DataStore。
 *
 * 为什么单独一个文件：`cloud.js` 那套是「登录 + 云端数据库」，桌面版要的是
 * 「本机 Steam 文件 + 本机浏览器存储」。两条路的数据来源、身份确认、失败处理全不一样，
 * 塞进同一个文件迟早互相绊（cloud.js 已经 1600 行量级了）。
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
  var META_PER_RUN = 45;    // 一轮最多补多少款
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
   * 返回 `{filled, left}`：`filled` = 这次真的补到内容的款数，
   * `left > 0` = 还有剩的，下次接着补。
   */
  async function fillMeta(appids) {
    if (!window.DataStore) return { filled: 0, left: 0, reason: 'no_datastore' };

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
      if (g.title && g.header) return;         // 名字和封面都有，没什么可补
      want.push(k);
    });
    if (!want.length) return { filled: 0, left: 0 };

    // 上次试过、判定链路不通且还没到期 → 直接跳过（不发任何请求）
    var down = linkDownAt();
    if (down && Date.now() - down < META_DOWN_TTL) {
      return { filled: 0, left: want.length, skipped: 'link_down' };
    }

    var work = want.slice(0, META_PER_RUN);
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
        try { await window.DataStore.mergeSteam(recs); }
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
      return postJSON('/api/local/settings', { steamDir: p || '' }, 10000)
        .then(function (r) {
          var b = r.body || {};
          return { ok: !!b.ok, reason: b.reason || '', data: b };
        })
        .catch(function (e) {
          return { ok: false, reason: '本机服务没有响应（' + ((e && e.message) || e) + '）',
                   data: null };
        });
    }
  };
})();
