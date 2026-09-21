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
 * 实测：本机约 300 款 / 账号侧约 400 款，其中约九成没有名字（要联网补，见下一步）。
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

  window.GVLocal = {
    probe: probe,
    load: load,
    toRecords: toRecords,
    sync: sync,

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
