/*
 * EPIC 数据源（Windows 桌面版）—— 把 `/api/local/epic` 接进 DataStore。
 *
 * 为什么单独一个文件：数据源里有 EPIC 自己的语义（本机文件在哪、哪些字段拿不到、
 * "没装 EPIC"该怎么说），而 `js/platforms.js` 是一张**零依赖、零副作用**的纯声明表
 * （它排在 store.js / ui.js 之前，只登记数据、不发请求）。两者不该混。
 * 所以：**声明在 platforms.js，数据源在这里**，由本文件在加载时挂上去：
 *
 *     PF.registerSource('epic', { probe, sync, loadingText })
 *
 * 收益是界面那侧**彻底不需要知道平台名** —— `ui.js` 只问"当前平台有没有数据源"，
 * 有就调它的 `probe` / `sync`，没有就说"接不进来"。加第三个平台时 ui.js 一行不用改。
 *
 * ============================================================
 * 🔴 这里**没有**、也不该有的东西
 * ============================================================
 * · **没有账号 / 没有 API Key / 没有目录设置** —— EPIC 这条路是纯读盘：
 *   `%PROGRAMDATA%\Epic\...` 下那两份文件是**机器级共享**的，不需要你是谁。
 * · **不联网** —— 唯一的外网依赖是封面图 URL（那是 `<img>` 自己去取的，
 *   与应用的数据链路无关）。所以这里不会出现"链路不通"这一类失败。
 * · **不去点 EPIC 的登录** —— 登录要用户在自己的浏览器里粘 `authorization_code`，
 *   而 EPIC 在那个页面上**自己写着**"别把这个 code 给任何第三方"。本阶段不碰，
 *   详见 DESIGN.md 的「平台轴」一节。
 *
 * ============================================================
 * 🔴 「探一下」和「导进来」是**两个**动作，不要合并
 * ============================================================
 * `probe()` 只读：把"本机有什么"问出来给占位区显示；`sync()` 才会写库。
 * 分开的理由：**切标签页是导航，不是操作**。把它做成"切过去就自动导入"，
 * 就是在用户没下任何指令的情况下替他写数据 —— 出问题的时候没人知道是谁写的。
 */
(function () {
  'use strict';

  var PF = window.GVPlatforms;
  var ID = 'epic';                 // 它自己的平台 id —— 只该出现在**它自己的**数据源文件里

  // 纯读盘，正常 <200ms（535KB base64 + 几十个小 JSON）。给 20 秒纯粹是防卡死。
  var TIMEOUT = 20000;

  /**
   * GET 一个 JSON。**非 2xx 也把 body 交出来**（只要它是 JSON）——
   * 服务端的失败响应本身就是说明书：`{"ok":false,"reason":"epic_not_found"}`。
   * 用 `fetch().json()` 直接抛，会把这些原因全吞掉，只剩一句"服务没有响应"，
   * 而"没装 EPIC"和"服务挂了"的解法完全相反。
   */
  function getJSON(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var ctl = null, timer = null;
      try {
        ctl = new AbortController();
        timer = setTimeout(function () { ctl.abort(); }, timeoutMs || TIMEOUT);
      } catch (e) { /* 没有 AbortController 就不带超时，别因此整个功能不可用 */ }
      var opt = { cache: 'no-store' };
      if (ctl) opt.signal = ctl.signal;
      fetch(url, opt).then(function (r) {
        return r.json().then(function (d) { return d; }, function () { return {}; })
          .then(function (d) {
            if (!r.ok && !(d && d.reason)) throw new Error('HTTP ' + r.status);
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

  function load() { return getJSON('/api/local/epic', TIMEOUT); }

  /** reason → 给用户看的一句话。**文案只在这里写一份**（别在 ui.js 里另抄一遍）。
   *
   * ⚠️ 这些字是**直接 textContent 进页面的**，没有 Markdown 渲染 ——
   *    别在里面写 `**加粗**`，那会原样显示成星号（出图时实测过一版，
   *    占位区里明晃晃写着「只能从**本机文件**里读」）。要强调就用中文引号或破折号。
   */
  var REASON_TEXT = {
    no_desktop: 'EPIC 没有公开的库接口，它的库只能从「本机文件」里读 —— ' +
                '所以只有桌面版读得到，双击 index.html 打开的这一版不行。',
    epic_not_found: '这台机器上没有找到 EPIC —— 没装 EPIC 启动器，或者装在别处。' +
                    '装好并登录过一次启动器之后，再点一次「同步」。',
    fetch_failed: '本机服务没有响应，稍后再点一次「同步」。',
    bad_response: '本机服务返回的内容看不懂。',
    empty: 'EPIC 那边一款游戏都没读到。'
  };

  function reasonText(reason) {
    return REASON_TEXT[reason] || ('没读到 EPIC 的库（' + (reason || '原因不明') + '）。');
  }

  /**
   * 服务端响应 → 统一结果 `{ok, reason, text, total, installed, warn}`。
   *
   * ⚠️ 「整库缓存没读懂」是**部分成功**，不是失败：安装清单那半还能用。
   *    这种情况 `ok` 仍然是真，但要带一句 warn —— 否则用户看到"找到 12 款"
   *    会以为这就是他的全部 EPIC 库（而他可能有一百多款）。
   */
  function summarize(d) {
    if (!d || typeof d !== 'object') {
      return { ok: false, reason: 'bad_response', text: reasonText('bad_response') };
    }
    if (d.reason) {
      return { ok: false, reason: d.reason, text: reasonText(d.reason) };
    }
    var st = d.stats || {};
    var warn = '';
    if (d.catalogFound && !d.catalogOk) {
      warn = ' ⚠️ 整库缓存（catcache.bin）没读懂，这次只有已安装的那些。';
    }
    if (!(st.total > 0)) {
      return { ok: false, reason: 'empty', text: reasonText('empty') + warn };
    }
    return {
      ok: true, total: st.total, installed: st.installed || 0,
      named: st.named || 0, withCover: st.withCover || 0, warn: warn
    };
  }

  /** 只读探一次：本机 EPIC 库里有什么。**不写任何数据。** */
  async function probe() {
    var d = null;
    try {
      d = await load();
    } catch (e) {
      // 拉不到 = 不是桌面版（`/api/local/*` 根本不存在）或服务端卡住。
      // 两种都不是错误，是"这条路在这台机器上走不通"。
      return { ok: false, reason: 'no_desktop', text: reasonText('no_desktop') };
    }
    var r = summarize(d);
    if (!r.ok) return r;
    return {
      ok: true, total: r.total, installed: r.installed,
      text: '本机 EPIC 库里找到 ' + r.total + ' 款（其中 ' + r.installed +
            ' 款已安装）。点上面的「同步」把它导进来。' + r.warn
    };
  }

  /**
   * 服务端记录 → `DataStore.mergePlatform` 认的记录形状。
   *
   * 🔴 字段名是**两条路共用的一份契约**（另一边是 `local-src.js` 的 `toRecords`）。
   *    别在这里发明新名字 —— 合并函数只认这几个，写错了不报错，只是数据静默不生效。
   * 🔴 封面「有才写」：留空的话将来还有机会补上；写成空字符串会把
   *    `src.header || old.header` 那条路堵死（和 Steam 那边同一条纪律）。
   * 🔴 **不写 `collections`** —— EPIC 没有收藏夹这个概念，带上一个空数组
   *    会被当成"它的收藏夹是空的"这类结论。
   */
  function toRecords(games) {
    var out = [];
    (games || []).forEach(function (g) {
      if (!g || !g.appid) return;
      var rec = {
        appid: g.appid,
        platform: ID,
        // `source` = 「这条记录在**它自己那个平台**里的身份」（角标语义）。
        // EPIC 这份整库**每一款都是已拥有**（它是权益目录），所以这个值对
        // 本平台内部的角标没有区分度 —— 真正有信息量的是下面的 `installed`。
        source: 'epic',
        title: g.title || '',
        developer: g.developer || '',
        releaseDate: g.releaseDate || '',
        installed: !!g.installed,
        installSize: g.installSize || 0,
        // ⚠️ AppName 只作为**附带字段**存着（它是发版代号，不是标题、更不是 id）。
        //    留它是因为它是跨商店对号入座的钥匙 —— 以后要做"同一款游戏 Steam 和
        //    EPIC 都有"的去重，靠的就是它。
        epicAppName: g.appName || '',
        epicId: g.epicId || ''
      };
      if (g.cover) { rec.header = g.cover; rec.icon = g.cover; }
      if (g.coverKind) rec.coverKind = g.coverKind;   // 如实回报封面是横版还是竖版
      out.push(rec);
    });
    return out;
  }

  /**
   * 读本机 EPIC 库并合并进 DataStore。**会写库。**
   *
   * 🔴 失败时**绝不动数据**：`summarize` 不过就直接返回，一个请求都不往外发。
   *    宁可这次不导入，也不能拿半份结果去合并 —— 与愿望单那条守卫同一个道理
   *    （`local-src.js` 的 syncWishlist 里那段说明）。
   */
  async function sync() {
    if (!window.DataStore) return { ok: false, reason: 'no_datastore', text: '数据层没就绪。' };
    if (!window.DataStore.mergePlatform) {
      return { ok: false, reason: 'no_merger', text: '这个版本不支持按平台合并记录。' };
    }
    var d = null;
    try {
      d = await load();
    } catch (e) {
      return { ok: false, reason: 'no_desktop', text: reasonText('no_desktop') };
    }
    var r = summarize(d);
    if (!r.ok) return r;

    var records = toRecords(d.games);
    if (!records.length) return { ok: false, reason: 'empty', text: reasonText('empty') };

    var res = await window.DataStore.mergePlatform(records);
    return {
      ok: true,
      total: records.length,
      installed: r.installed,
      added: res.added, updated: res.updated,
      text: 'EPIC：读到 ' + records.length + ' 款（' + r.installed + ' 款已安装），' +
            '新增 ' + res.added + ' / 更新 ' + res.updated + '。' + r.warn
    };
  }

  PF.registerSource(ID, {
    loadingText: '正在读本机 EPIC 库…',
    label: '本机 EPIC 库',
    probe: probe,
    sync: sync
  });
})();
