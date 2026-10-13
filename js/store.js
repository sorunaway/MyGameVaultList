/*
 * MyGameVaultList — Steam 游戏历程管理器
 * 数据层：统一的 Game 模型 + IndexedDB 持久化
 * 设计原则：手动标记优先于 Steam 自动同步，绝不被覆盖
 */

(function (global) {
  'use strict';

  // ===== 状态枚举 =====
  const STATUS = {
    LIBRARY:   'library',    // 我的游戏单（总表：Steam 库 + 愿望单）
    BACKLOG:   'backlog',    // 待游玩
    PLAYING:   'playing',    // 正在游玩
    PAUSED:    'paused',     // 暂停区
    COMPLETED: 'completed',  // 已通关
    ABANDONED: 'abandoned'   // 放弃区（手动终态：不打算再玩了）
  };

  const STATUS_META = {
    library:   { key: 'library',   label: '我的游戏单', icon: '📚', color: '#6b7280', desc: 'Steam 库 + 愿望单，全在这里' },
    backlog:   { key: 'backlog',   label: '待游玩',    icon: '🎯', color: '#3b82f6', desc: '想玩但还没开始' },
    playing:   { key: 'playing',   label: '正在游玩',  icon: '🔥', color: '#f59e0b', desc: '90 天内启动过' },
    paused:    { key: 'paused',    label: '暂停区',    icon: '⏸️', color: '#8b5cf6', desc: '超过 90 天没启动' },
    completed: { key: 'completed', label: '已通关',    icon: '🏆', color: '#10b981', desc: '打完了，已归档' },
    abandoned: { key: 'abandoned', label: '放弃区',    icon: '🗑️', color: '#78716c', desc: '不打算再玩了，已出局' }
  };

  // 状态视图顺序（不含总库）
  // 放弃区排最后：它是一个"出局"名单，不是主线进度
  const VIEW_ORDER = [STATUS.BACKLOG, STATUS.PLAYING, STATUS.PAUSED,
                      STATUS.COMPLETED, STATUS.ABANDONED];

  // ===== Steam 收藏夹 -> 状态含义（名字由用户自己定）=====
  //
  // 收藏夹是每个人在 Steam 里自己建的、名字随心，所以**不能写死**：
  // 默认那四个名字都是我们起的，其中只有「已隐藏」是 Steam 自带的（「已完结」也得玩家
  // 自己在 Steam 里建）—— 用户在「设置」里可以随时改成自己习惯的名字。
  // 同步脚本会把收藏夹名原样写进 games[].collections，这里只负责"哪个名字算什么状态"。
  const PREFS_KEY = 'gv_prefs_v1';

  const DEFAULT_PREFS = {
    completedCollections: ['已完结'],   // -> 归入「已通关」（终态，优先级最高）
    backlogCollections:   ['待游玩'],   // -> 归入「待游玩」（只接"从没启动过"的款）
    abandonedCollections: ['已放弃'],   // -> 直接进「放弃区」（**不看**玩没玩过）
    hiddenCollections:    ['已隐藏']    // -> 视为用户主动隐藏（优先级最高）
  };

  // ⚠️ 这四个默认名里**只有「已隐藏」是 Steam 自带的** —— 2026-10-13 用户纠正：
  //    「已完结」也是玩家自己在 Steam 里建的，不是内置分类（我原来把它也算成
  //    Steam 自带的，界面上写错了）。用户本机没有对应的收藏夹时它天然不会命中、
  //    什么也不会发生，所以给默认值是安全的。
  //    用户本机没有这个收藏夹时它天然不会命中，什么也不会发生，所以给默认值是安全的。

  // 旧版本把「归入已通关」的收藏夹硬编码成这一个名字，老用户的数据就带着它。
  // 升级时若在数据里真的见到它，就沿用它，免得老用户整片「已通关」回退。
  const LEGACY_COMPLETED_COLLECTION = '完结撒花';

  let prefs = null;

  /** 去空白、去重，支持「数组」或「逗号/顿号分隔的字符串」两种入参 */
  function normalizeNames(v) {
    const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,，、]/);
    const out = [];
    arr.forEach(x => {
      const s = String(x == null ? '' : x).trim();
      if (s && out.indexOf(s) < 0) out.push(s);
    });
    return out;
  }

  function readPrefs() {
    if (prefs) return prefs;
    prefs = {
      completedCollections: DEFAULT_PREFS.completedCollections.slice(),
      backlogCollections:   DEFAULT_PREFS.backlogCollections.slice(),
      abandonedCollections: DEFAULT_PREFS.abandonedCollections.slice(),
      hiddenCollections:    DEFAULT_PREFS.hiddenCollections.slice(),
      // 用户有没有亲手改过这四项 —— 决定要不要做老数据迁移
      completedTouched: false,
      backlogTouched:   false,
      abandonedTouched: false,
      hiddenTouched:    false
    };
    try {
      const raw = global.localStorage.getItem(PREFS_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === 'object') {
        const c = normalizeNames(saved.completedCollections);
        const b = normalizeNames(saved.backlogCollections);
        const a = normalizeNames(saved.abandonedCollections);
        const h = normalizeNames(saved.hiddenCollections);
        // 空列表按"没设过"处理 —— 存成空会让「已通关」永远没人进
        if (c.length) prefs.completedCollections = c;
        if (b.length) prefs.backlogCollections = b;
        if (a.length) prefs.abandonedCollections = a;
        if (h.length) prefs.hiddenCollections = h;
        prefs.completedTouched = !!saved.completedTouched;
        prefs.backlogTouched   = !!saved.backlogTouched;
        prefs.abandonedTouched = !!saved.abandonedTouched;
        prefs.hiddenTouched    = !!saved.hiddenTouched;
      }
    } catch (e) {
      // 隐私模式 / 禁用存储：localStorage 会直接抛错。用默认值继续，不影响数据。
    }
    return prefs;
  }

  function writePrefs() {
    try { global.localStorage.setItem(PREFS_KEY, JSON.stringify(readPrefs())); }
    catch (e) { /* 存不下就算了，偏好丢了不影响游戏数据 */ }
  }

  function getPrefs() {
    const p = readPrefs();
    return {
      completedCollections: p.completedCollections.slice(),
      backlogCollections:   p.backlogCollections.slice(),
      abandonedCollections: p.abandonedCollections.slice(),
      hiddenCollections:    p.hiddenCollections.slice(),
      completedTouched:     p.completedTouched,
      backlogTouched:       p.backlogTouched,
      abandonedTouched:     p.abandonedTouched,
      hiddenTouched:        p.hiddenTouched
    };
  }

  /**
   * 改偏好。四项都接受「数组」或「逗号分隔的字符串」。
   * 传空 = 没填 = 回到默认（不存空列表，否则等于把该条自动归类关掉）。
   */
  function setPrefs(patch) {
    const p = readPrefs();
    if (patch && patch.completedCollections !== undefined) {
      const v = normalizeNames(patch.completedCollections);
      p.completedCollections = v.length ? v : DEFAULT_PREFS.completedCollections.slice();
      p.completedTouched = true;
    }
    if (patch && patch.backlogCollections !== undefined) {
      const v = normalizeNames(patch.backlogCollections);
      p.backlogCollections = v.length ? v : DEFAULT_PREFS.backlogCollections.slice();
      p.backlogTouched = true;
    }
    if (patch && patch.abandonedCollections !== undefined) {
      const v = normalizeNames(patch.abandonedCollections);
      p.abandonedCollections = v.length ? v : DEFAULT_PREFS.abandonedCollections.slice();
      p.abandonedTouched = true;
    }
    if (patch && patch.hiddenCollections !== undefined) {
      const v = normalizeNames(patch.hiddenCollections);
      p.hiddenCollections = v.length ? v : DEFAULT_PREFS.hiddenCollections.slice();
      p.hiddenTouched = true;
    }
    writePrefs();
    return getPrefs();
  }

  /** 出厂默认值（「恢复默认」按钮用；点它只填回输入框，点保存才真正生效） */
  function defaultPrefs() {
    return {
      completedCollections: DEFAULT_PREFS.completedCollections.slice(),
      backlogCollections:   DEFAULT_PREFS.backlogCollections.slice(),
      abandonedCollections: DEFAULT_PREFS.abandonedCollections.slice(),
      hiddenCollections:    DEFAULT_PREFS.hiddenCollections.slice()
    };
  }

  /**
   * 找出**四格之间**的重名收藏夹 —— 设置面板保存前的唯一判据（2026-10-13 用户提：
   * 「我尝试了在设置里给每一格都设置了相同的几个文件夹，这个时候程序的归类就乱了」）。
   *
   * 返回 `{ completed: [名…], backlog: […], abandoned: […], hidden: […] }`，
   * 只列**在该格真的触发冲突**的名字（即与其它某一格重名）；四格互不重名时返回 `{}`。
   *
   * 🔴 两处刻意的语义，改之前先想清楚：
   *  1. **按"保存后会真正生效的值"算，空框 = 默认名**。`setPrefs` 对空串的语义是
   *     "回到默认"（见上面的 `v.length ? v : DEFAULT_PREFS…`），所以用户**清空**一格
   *     并不等于消掉冲突 —— 他删掉「已隐藏」，默认名「已隐藏」照样在那儿。
   *     若按"框里打了什么"判，界面会放行一次**看着修好了、实际照旧**的保存。
   *     代价是空框也可能被判重名 → 界面上的提示必须写清「留空 = 默认名」。
   *  2. **同一格内写重复不算错** —— `normalizeNames` 本来就会去重（既有行为），
   *     那不是用户要解决的问题，别在这里拦他。
   *
   * 入参可给 `{completedCollections: …}` 或直接给字符串（内部走 `normalizeNames`，
   * 中英文逗号、顿号都认）。比较用**去空格后精确相等**，与 `inAnyCollection` 的
   * `indexOf` 是同一把尺子 —— 判据不一致的话，界面说"没冲突"而归类却打架。
   */
  function duplicateCollections(vals) {
    const raw = vals || {};
    const KINDS = ['completed', 'backlog', 'abandoned', 'hidden'];
    const eff = {};
    KINDS.forEach(k => {
      const given = normalizeNames(raw[k + 'Collections']);
      // 空 = 没填 = 落到默认名。**与 setPrefs 完全一致**，别在这里另立一套规则。
      eff[k] = given.length ? given : DEFAULT_PREFS[k + 'Collections'].slice();
    });
    const out = {};
    KINDS.forEach(k => {
      const dup = eff[k].filter(n =>
        KINDS.some(o => o !== k && eff[o].indexOf(n) >= 0));
      if (dup.length) out[k] = dup;
    });
    return out;
  }

  /** 数据里实际出现过的收藏夹名（给设置面板做候选，省得用户手敲） */
  function collectionsInData(games) {
    const out = [];
    (games || []).forEach(g => {
      (g && Array.isArray(g.collections) ? g.collections : []).forEach(c => {
        const s = String(c == null ? '' : c).trim();
        if (s && out.indexOf(s) < 0) out.push(s);
      });
    });
    return out;
  }

  /**
   * 迁移：老版本把「归入已通关」写死成 '完结撒花'，老用户数据里带着这个分类名。
   * 见到它就一并认下来，避免升级后整片「已通关」掉出去。
   *
   * 三个刻意的设计：
   *  1. **只认这一个历史名字，绝不猜别的**。猜错（比如把某个自定义分类当成
   *     "通关"）会把一批没打完的游戏错误地归档，比不迁移糟得多。
   *  2. **追加而不是替换**。用户可能同时有「已完结」和「完结撒花」两个分类，
   *     替换会把他另一个丢掉。
   *  3. **只认它一次**：只要用户亲手保存过设置（completedTouched），就再也不动。
   *
   * 🔴 **调用时机很要紧**：必须在「调用方按 suggestStatus 预先算好归类」**之前**调。
   *    否则那些款会带着迁移前算出的「我的游戏单」入库 —— mergeSteam 的新建分支
   *    用的是入参里的 suggestedStatus（云端那条路要靠它还原数据库里的状态，
   *    所以不能在里面无条件重算）。实测踩过：种子数据导入时库还是空的，
   *    mergeSteam 内部那次迁移看不到任何"老数据"，多数「已通关」只剩一小部分。
   */
  function adoptLegacyCollection(games) {
    const p = readPrefs();
    if (p.completedTouched) return false;
    if (p.completedCollections.indexOf(LEGACY_COMPLETED_COLLECTION) >= 0) return false;

    const has = (games || []).some(g =>
      Array.isArray(g && g.collections) &&
      g.collections.indexOf(LEGACY_COMPLETED_COLLECTION) >= 0);
    if (!has) return false;

    p.completedCollections = p.completedCollections.concat([LEGACY_COMPLETED_COLLECTION]);
    writePrefs();
    return true;
  }

  function inAnyCollection(game, names) {
    if (!game || !Array.isArray(game.collections) || !names.length) return false;
    return game.collections.some(c => names.indexOf(c) >= 0);
  }

  /** 该游戏是否在「归入已通关」的收藏夹里（名字以设置里的为准） */
  function inCompletedCollection(game) {
    return inAnyCollection(game, readPrefs().completedCollections);
  }

  /**
   * 该游戏是否在「归入待游玩」的收藏夹里（名字以设置里的为准）。
   *
   * ⚠️ 这个判断**只在 `suggestStatus` 的第 8 步用**，而且那一步的位置是刻意的：
   *    它排在"启动日期分流"**之后** → 只有**从没启动过**的款才可能命中。
   *    也就是说，即使你把一款正在玩的游戏拖进「待游玩」收藏夹，它也不会被
   *    拽出「正在游玩」—— 那正是这条收藏夹的定义（**想玩但还没开始**）。
   */
  function inBacklogCollection(game) {
    return inAnyCollection(game, readPrefs().backlogCollections);
  }

  /**
   * 该游戏是否在「归入已放弃」的收藏夹里（名字以设置里的为准）。
   *
   * 🔴 跟「待游玩」那格的关键差别：这一格**不看**玩没玩过、多久没碰 ——
   *    收藏夹里写着就是放弃。两格的分工就写在名字上：
   *    「待游玩」= 想玩还没开始，「已放弃」= 不打算玩了。
   */
  function inAbandonedCollection(game) {
    return inAnyCollection(game, readPrefs().abandonedCollections);
  }

  /**
   * 该不该由「已放弃」收藏夹把它**自动**放进放弃区。
   *
   * ⚠️ `abandonDismissed` 是用户的手动否决：他在款**还留在**收藏夹里的情况下
   *    手动把它挪出了放弃区 -> 就别再自动塞回去（否则每次都跟用户对着干）。
   *    把款移出收藏夹再放回来，这个否决作废（见 mergeSteam 末尾那段收口）。
   */
  function wantsAbandon(game) {
    return inAbandonedCollection(game) && !game.abandonDismissed;
  }

  /** 该游戏是否在「视为已隐藏」的收藏夹里（用户主动隐藏，优先级最高） */
  function inHiddenCollection(game) {
    return inAnyCollection(game, readPrefs().hiddenCollections);
  }

  // ===== 工具函数 =====
  function uid() {
    return 'g_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  /** 秒级时间戳 -> YYYY-MM-DD */
  function tsToDate(ts) {
    if (!ts || ts <= 0) return null;
    const d = new Date(ts * 1000);
    if (isNaN(d.getTime())) return null;
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function yearOf(ts) {
    const s = tsToDate(ts);
    return s ? Number(s.slice(0, 4)) : null;
  }

  // ===== 通关年份（`doneAt`）=====
  //
  // 需求（2026-09-30）：「已通关」区要能按年份分段，一眼看出今年 / 去年通关了哪些。
  //
  // 🔴 **一个字段，三种取值** —— 语义必须钉死，否则下一个人会把 -1 当成脏数据清掉：
  //      > 0        真实通关时间（秒）
  //      -1         **已定格，但年份未知**（进「年份未定」段，用户可以拖到某年）
  //      0 / 缺失   尚未定格（等一次回填，或等它第一次被归入「已通关」）
  //
  // 🔴 **已定格就永不再自动改** —— 这是需求的原话（"只要已经存在「已通关」内
  //    （非初次归入已通关），就不再自动检测归类年表"）。所以**不能**渲染时按
  //    `lastPlayedTs` 现算：2025 通关的款 2026 重玩一次，年份就会自己跳到 2026。
  //    `doneAt` 是**写死的**，只有用户手动改（拖放 / 详情面板）才会变。
  const DONE_UNKNOWN = -1;

  /** 这条记录落在哪一年；"未定格 / 年份未知"都返回 null（由调用方归到「年份未定」段） */
  function doneYearOf(g) {
    const ts = g && g.doneAt;
    return (ts && ts > 0) ? yearOf(ts) : null;
  }

  /**
   * 首次归入「已通关」时写通关时间 —— **只写一次**。
   *
   * ⚠️ 判据是"有没有定格过"，不是"值是不是空"：`-1` 也算定格（用户把它拖到
   *    「年份未定」了），这里必须跳过；否则下次同步又按 `lastPlayedTs` 把它塞回某年，
   *    用户刚拖走的动作就被悄悄撤销了。
   *
   * @param {object} g  记录
   * @param {number} ts 想写的时刻（秒）。拿不到时间就传 0/空 → 定格为 DONE_UNKNOWN
   * @returns {boolean} 是否写了（已定格 / 状态不是已通关 → false）
   */
  function touchDoneAt(g, ts) {
    if (!g || g.status !== STATUS.COMPLETED) return false;
    if (g.doneAt) return false;                    // 已定格（正数或 -1）
    const n = Number(ts);
    g.doneAt = (isFinite(n) && n > 0) ? Math.floor(n) : DONE_UNKNOWN;
    return true;
  }

  /**
   * 手动把一款游戏放到某一年 —— 拖放与详情面板**共用这一个**。
   *
   * 规则：**只换年份，保留月日**（"2026-03-14"拖到 2025 → "2025-03-14"）。
   *   · 2 月 29 日遇到平年 → 退回 2 月 28 日。不许让 JS 自己滚成 3 月 1 日：
   *     那会让"只改年份"变成"日期也偷偷变了"，而用户拖的是年份。
   *   · 原本未定格 / 年份未知 → 落成那年 **1 月 1 日中午**。
   *     取中午而不是 0 点：`new Date(y,0,1)` 是本地零点，转成秒后再被任何一处
   *     当成 UTC 解释就会挤到上一年 12 月 31 日（年份差一年，最难查的那种）。
   *
   * @param {object} g    记录
   * @param {number} year 目标年份；传 `DONE_UNKNOWN` = 拖回「年份未定」
   */
  function setDoneYear(g, year) {
    if (!g) return false;
    if (year === DONE_UNKNOWN || year == null || year === '') {
      g.doneAt = DONE_UNKNOWN;
      return true;
    }
    const y = Number(year);
    if (!isFinite(y) || y < 1970 || y > 2200) return false;
    const cur = Number(g.doneAt) || 0;
    let d;
    if (cur > 0) {
      d = new Date(cur * 1000);
      const mo = d.getMonth();
      d.setFullYear(y);
      if (d.getMonth() !== mo) d.setDate(0);       // 2/29 → 平年：退回当月最后一天(2/28)
    } else {
      d = new Date(y, 0, 1, 12, 0, 0);
    }
    g.doneAt = Math.floor(d.getTime() / 1000);
    return true;
  }

  /**
   * 一次性回填：把"已经在「已通关」里、但还没定格"的记录补上年份。
   *
   * 🔴 为什么用 `lastPlayedTs` 而不是 `statusManualAt`：
   *    手上这批「已通关」大多是**后来手工补录**的，`statusManualAt` 会全部挤在
   *    补录那一天（几乎全落同一年）；而 `lastPlayedTs` 说的是"最后玩它的那一刻"，
   *    更接近真实通关年份。
   *
   * ⚠️ 拿不到时间（`lastPlayedTs` 为 0：手动添加的、愿望单转正的、别的平台给不出
   *    这一项的记录）→ 定格为 `DONE_UNKNOWN`，落在「年份未定」段等用户拖。**不许猜。**
   *
   * 幂等：判据就是 `touchDoneAt` 里那条"已定格就跳过"，跑多少次结果都一样。
   * @returns {{filled:number, unknown:number}} 写了多少条 / 其中有多少落进「年份未定」
   */
  async function backfillDoneAt() {
    const all = await DataStore.all();
    const changed = [];
    let unknown = 0;
    (all || []).forEach(g => {
      if (!g || g.status !== STATUS.COMPLETED) return;
      if (!touchDoneAt(g, g.lastPlayedTs)) return;
      if (g.doneAt === DONE_UNKNOWN) unknown++;
      changed.push(g);
    });
    if (changed.length) await DataStore.saveMany(changed);
    return { filled: changed.length, unknown: unknown };
  }

  /**
   * 写入「这位玩家为这款游戏写的评测」—— **专用 setter，只动三个字段**。
   *
   * 🔴 为什么不复用 mergeSteam / mergeMeta：那两个是**同步**用的，语义是
   *    "外部数据源覆盖本机记录"。而这条数据是从网页抓来的**一小段文本** ——
   *    它既不改变"这条记录是不是我的"，也不改变归类状态。走同步那条路就会被
   *    mergeSteam 那套规则顺手改写 `source`（2026-10-10 已经因此把一批愿望单的款
   *    标成「已拥有」，见 mergeMeta 的说明）。
   *
   * 🔴 也不碰 `status` / `collections` / 时长 / 成就 —— 抓一条评测不该让这款
   *    在「我的游戏单」和「正在游玩」之间跳一下。
   *
   * 三态的字段约定见 `makeGame` 里 `steamReview` 那段。
   *
   * @param {object} g      记录（调用方手里那条）
   * @param {object|null} review
   *        正常抓到时传 `{text, recommend, recommendText, date, hours}`；
   *        传 `null` = 记下「抓过了，这位玩家确实没写」。
   *        ⚠️ 传 null **不等于**"抓取失败" —— 失败根本不该调用这个函数
   *        （失败了库里的旧值要原样留着，不能被一次链路抖动清掉）。
   * @returns {boolean} 有没有真的改动
   */
  function setReview(g, review) {
    if (!g) return false;
    const now = Math.floor(Date.now() / 1000);

    if (!review) {
      // 「确定没写过」也要落时间戳，否则下次打开又变回"从没抓过"，
      // 用户会以为上次那次抓取白点了。
      // 幂等：已经是"抓过且为空"就什么都不做（别每次都写一遍库）。
      if (g.steamReviewAt && !g.steamReview) return false;
      g.steamReview = '';
      g.steamReviewAt = now;
      g.steamReviewMeta = null;
      return true;
    }

    g.steamReview = (typeof review.text === 'string') ? review.text : '';
    g.steamReviewAt = now;
    g.steamReviewMeta = {
      // 三值：true / false / null（认不出推荐与否 —— 那就别显示一个猜的结论）
      recommend: (review.recommend === true || review.recommend === false)
        ? review.recommend : null,
      recommendText: String(review.recommendText || ''),
      date: String(review.date || ''),
      hours: (typeof review.hours === 'number' && isFinite(review.hours))
        ? review.hours : null
    };
    return true;
  }

  /**
   * 批量写入「同步时扫到的评测列表」（走 `GVLocal.fetchReviews` 那条路）。
   *
   * 🔴 **专用 setter**：只碰 `steamReview` / `steamReviewAt` / `steamReviewMeta`
   *    （具体三态见 `makeGame` 里 `steamReview` 那段）。
   *    绝不借 `mergeSteam` / `mergeMeta` —— 那两个是**同步**用的，会顺手改写
   *    `source`（2026-10-10 已经因此把一批愿望单的款标成「已拥有」，见 `setReview` 的说明）。
   *    也绝不碰 `status` / `collections` / 时长 / 成就 —— 填一条评测不该让这款
   *    在「我的游戏单」和「正在游玩」之间跳一下。
   *
   * 🔴 只对**库里已经有**的那条写：按 (平台, appid) 定位，找不到就跳过。
   *    扫到一篇"库里没有的款"的评测是正常的（评测页比库留得久），
   *    为它新建一条记录等于凭空往库里塞游戏。
   *
   * 🔴 只**填空**，不覆盖已有的正文。
   *    已经有 `steamReview` 的那条是用户点「重新抓取」从单篇页拿到的 ——
   *    日期**精确到分钟**（`8 月 23 日 上午 5:49`），而列表页只有日期
   *    （`8 月 23 日`）。被简略版盖掉，用户会觉得"我抓的那次白抓了"。
   *    ⚠️ 反过来，「抓过但确认没写过」（`steamReviewAt` 有值、正文为空）**要**写 ——
   *       列表页里出现了它，说明他后来写了（或者当初那次判断错了）。
   *
   * @param {Array} items [{appid, text, recommend, recommendText, date, hours}, …]
   * @returns {Promise<{scanned:number, matched:number, written:number}>}
   *          scanned = 扫到几篇；matched = 其中库里有的几篇；written = 真写进去的几篇
   */
  async function setReviewsBulk(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return { scanned: 0, matched: 0, written: 0 };

    const existing = await DataStore.all();
    const byKey = new Map();
    (existing || []).forEach(g => {
      if (!g || g.appid == null) return;
      byKey.set(GVPlatforms.of(g) + ':' + String(g.appid), g);
    });

    const toSave = [];
    let matched = 0;
    list.forEach(src => {
      if (!src || src.appid == null) return;
      // ⚠️ 键里带平台：评测页是 Steam 的，它的答案只对默认平台那条记录有效
      //    （同 mergeMeta 里那条注释）。别的平台的记录天然落不进来。
      const g = byKey.get(GVPlatforms.DEFAULT_ID + ':' + String(src.appid));
      if (!g) return;
      matched++;
      if (g.steamReview) return;          // 已有正文 → 保留（见上面第三条）
      if (setReview(g, src)) {
        g.updatedAt = Date.now();
        toSave.push(g);
      }
    });

    if (toSave.length) await DataStore.saveMany(toSave);
    return { scanned: list.length, matched: matched, written: toSave.length };
  }

  /** 分钟 -> "12.5h" 形式 */
  function minutesToHours(min) {
    if (!min || min <= 0) return 0;
    return Math.round((min / 60) * 10) / 10;
  }

  /** 从 Steam 商店日期字符串里抠年份，兼容 "2023 年 3 月 3 日" / "3 Mar, 2023" */
  function parseReleaseYear(s) {
    if (!s) return null;
    const m = String(s).match(/(19|20)\d{2}/);
    return m ? Number(m[0]) : null;
  }

  // ===== 工具/软件黑名单 =====
  // Steam 库里常混入非游戏条目（引擎、工具、壁纸、跑分软件…）。
  // 这些默认标记为 hidden，不参与游戏区块展示，但可在「我的游戏单」里取消隐藏。
  const TOOL_APPIDS = new Set([
    404790,   // Godot Engine
    431960,   // Wallpaper Engine
    993090,   // Lossless Scaling
    228980,   // Steamworks Common Redistributables
    250820,   // SteamVR
    1070560,  // Steam Linux Runtime
    1391110,  // Steam Linux Runtime - Soldier
    1627300,  // Steam Linux Runtime - Sniper
    1904540,  // Proton Experimental
    1493710,  // Proton Experimental (alt)
    3658110,  // Steam Linux Runtime 4.0
    2180100,  // Proton Hotfix
    961940,   // Steam Linux Runtime - Soldier (alt)
  ]);

  // 名称关键词兜底（appid 会变，名字不会）
  const TOOL_NAME_PATTERNS = [
    /^godot engine$/i,
    /^wallpaper engine$/i,
    /^lossless scaling$/i,
    /steam linux runtime/i,
    /^proton\b/i,
    /^steamworks common/i,
    /^steamvr$/i,
    /redistributables/i,
    /^soundpad$/i,
    /^vtube studio$/i,
    /^live2dviewerex/i,
    /^3dmark/i,
    /^blender$/i,
    /^unreal engine$/i,
    /^unity\b/i,
    /^rpg maker/i,
    /^game maker/i,
  ];

  /** 判断是否是工具/软件（非游戏） */
  function isToolGame(game) {
    if (!game) return false;
    if (game.appid && TOOL_APPIDS.has(Number(game.appid))) return true;
    const t = String(game.title || '');
    return TOOL_NAME_PATTERNS.some(re => re.test(t));
  }

  // ===== 默认游戏对象 =====
  function makeGame(partial) {
    return Object.assign({
      id: uid(),
      appid: null,              // Steam AppID，手动添加可为 null
      title: '',
      icon: '',                 // 小图标 URL
      header: '',               // 大图 URL
      releaseYear: null,        // 发售年份
      releaseDate: null,        // 发售日期原文
      totalMinutes: 0,          // 总时长（Steam，分钟）
      recentMinutes: 0,         // 最近两周（分钟）
      lastPlayedTs: 0,          // 最后启动时间戳（秒）
      achievements: null,       // { earned, total }
      status: STATUS.LIBRARY,
      manualStatus: null,       // 手动设定的状态；非空则优先于自动同步
      statusManualAt: 0,        // 上次手动改状态的时间戳（秒）；晚于 lastPlayedTs 则保留手动结果
      statusLocked: false,      // 锁定：为 true 时完全不参与自动归类（用户钉死的）
      autoStatus: false,        // 当前状态是否由自动规则（启动日期）产生 —— 供 UI 打标记
      // 通关时间戳（秒）——「已通关」区年表的**唯一**依据。三种取值见 touchDoneAt。
      // ⚠️ 必须在这里给默认值：`makeGame` 是 `Object.assign(默认值, partial)`，
      //    默认值决定「备份导出 → 换台机器导入」时这个字段还在不在（少一行就是静默丢年份）。
      doneAt: 0,
      manualHidden: null,       // 手动设定过隐藏开关；非空则优先于自动判定
      dismissedCollection: false, // 用户主动把它从「已通关」挪走过，不再被收藏夹拉回
      // ===== 「放弃区」的来源标记（2026-10-13 起：放弃区有**两个**入口）=====
      //   ''            手动挪进去的 = **手动终态**，和锁定同级，同步一律不动
      //   'collection'  由「已放弃」收藏夹**自动**放进去的 -> 把款移出那个收藏夹，
      //                 下次同步就放它回自动规则（否则放弃区会变成死胡同）
      // 🔴 `abandonedBy !== ''` 精确等于「status === ABANDONED 且在收藏夹里」，
      //    这个不变量由 mergeSteam 末尾那段收口维护，别在别处另写一份。
      // ⚠️ 和 doneAt 一样必须在这里给默认值：`makeGame` 是
      //    `Object.assign(默认值, partial)`，少一行 = 备份导出 → 换机器导入时
      //    这个标记静默丢失（自动进来的款会被当成手动终态，再也放不出来）。
      abandonedBy: '',
      // 用户手动把它从放弃区挪走过（款**还在**「已放弃」收藏夹里）—— 不再自动塞回去。
      // 与 `dismissedCollection` 同构，同样必须进 makeGame 默认值。
      abandonDismissed: false,
      hidden: false,            // 是否隐藏（工具/软件默认隐藏）
      // 玩家自己写的评测（从社区页抓的，见 `local-src.js` 的 fetchReview）—— **三态**：
      //   steamReviewAt === 0            从没抓过（详情面板显示「抓取」按钮）
      //   > 0 且 steamReview === ''      抓过，这位玩家确实没写（**这不是失败**）
      //   steamReview !== ''             有正文
      // 🔴 三态缺一不可：少了时间戳，「抓过但没写」会被显示成「从没抓过」，
      //    用户会反复点那个按钮，而每次结果都一样 —— 看起来像按钮坏了。
      steamReview: '',
      steamReviewAt: 0,         // 上面那条是什么时候抓的（秒）；0 = 从没抓过
      // 抓到的元信息 {recommend, recommendText, date, hours}。
      // 只存正文的话，详情面板每次打开都要重抓一遍网页才能显示
      // 「推荐 / 发布日 / 总时数」—— 而那三个字正是判断"这条评测有没有参考价值"的依据。
      steamReviewMeta: null,
      myNote: '',               // 玩家手写感想
      genres: [],
      developers: [],
      collections: [],          // Steam 本地收藏夹名列表（同步脚本写入）
      // 这条记录**是从哪来的**，也是「我的游戏单」里那个角标的唯一依据：
      //   'steam'    它在你的 Steam 库里            -> 角标「已拥有」
      //   'wishlist' 它只在愿望单里，你还没买       -> 角标「未入库」
      //   'family'   它**不是你的**，是家庭共享里的  -> 角标「家人拥有」
      //   'manual'   你手动加的，Steam 那边不知道   -> 不挂角标（判断不了就别瞎标）
      // ⚠️ 愿望单游戏被买下后，mergeSteam 会把它改成 'steam'，角标随之变「已拥有」。
      // ⚠️ **家庭款不会**自动转正：它先以 'family' 进来之后，即使你自己买了同一款，
      //    也仍然停在 'family'（原因见 mergeSteam 里 `staysFamily` 那段注释 ——
      //    这一层分不清"我买了"和"共享副本装在我盘上"，宁可少标不可错标）。
      //    修它要先给"这条 payload 确实是我的账号库"加一个显式信号，属独立改动。
      source: 'manual',
      // ===== 以下两个字段只有「家人拥有」（source='family'）的记录才有意义 =====
      // ⚠️ 家人的时长**必须**单独放，**绝不能**并进 totalMinutes ——
      //    totalMinutes 的语义是「**我**玩了多久」，统计条的「总时长」「玩过」
      //    都直接读它。两者混在一起，库里的数字就再也说不清是谁的。
      familyOwners: [],      // [{name, steamId}] 家庭里拥有这款的人（从对方的公开库读到）
      familyMinutes: 0,      // 家人里玩得最久的那个的时长（分钟）
      // ===== 以下三个字段只有愿望单来源的记录才有意义 =====
      wishlisted: false,        // 此刻是否还在 Steam 愿望单里
      wishPriority: 0,          // 你在 Steam 里手动排的位次；0 = 没排过
      wishAddedTs: 0,           // 加入愿望单的时间戳（秒）
      // ===== 平台轴（见 js/platforms.js）=====
      // 🔴 `platform` 在这里**刻意不给默认值**，别顺手补一行 `platform: 'steam'`。
      //    "没写 platform 就是默认平台"（见 GVPlatforms.of）正是**老数据与旧备份
      //    一条都不用迁移**的来源；补上默认值会让这条性质看不出来，
      //    下一个人要加平台时就会以为非写迁移脚本不可。
      //
      // ===== 以下字段只有非默认平台（EPIC）的记录才有意义 =====
      // （命名规则和上面的 familyMinutes / wishPriority 一致：**按来源命名**，
      //   不硬造成通用字段 —— 通用名字会让"谁的语义"变得要猜）
      installed: false,       // 本机装了没有。EPIC 从安装清单读得到；Steam 侧不写它
      installSize: 0,         // 装机体积（字节）
      epicAppName: '',        // EPIC 的**发版代号**（`Bluebird` = Fez）——
                              // 只作跨商店对号入座的钥匙，**绝不当标题或 id**
      epicId: '',             // EPIC 自己的身份 `namespace:catalogItemId`，排查时对得上号
      coverKind: '',          // 封面是横版还是竖版。服务端两平台都回报它，
                              // 以后要按形状换画法（竖图塞横框会裁掉一大半）时靠它
      addedAt: Date.now(),
      updatedAt: Date.now()
    }, partial || {});
  }

  // ===== 自动归类规则 =====
  /**
   * 「最近启动过」的判定阈值：90 天（约三个月）。
   *
   * 在这个天数以内启动过 -> 正在游玩
   * 超过这个天数没启动   -> 已暂停
   *
   * 想调松/调紧只改这一个常量即可，其余逻辑不用动。
   */
  const RECENT_DAYS = 90;

  /** 距上次启动过去了多少天；没有启动记录返回 -1 */
  function daysSincePlayed(game, nowTs) {
    if (!game || !game.lastPlayedTs || game.lastPlayedTs <= 0) return -1;
    const now = nowTs || (Date.now() / 1000);
    const d = (now - game.lastPlayedTs) / 86400;
    // 时钟偏差 / 时区问题可能让 lastPlayedTs 落在未来，按「刚刚玩过」处理
    return d < 0 ? 0 : d;
  }

  /**
   * 「疑似已放弃」的提示阈值：730 天（两年）。
   *
   * ⚠️ 这个值**只用于界面提示，不参与任何自动归类**。
   * 「不想再玩了」是主观判断，数据推不出来 —— 所以这里只在暂停区里
   * 给超期很久的卡片挂一个淡色角标，提醒你去处理（手动标进放弃区）。
   */
  const STALE_DAYS = 730;

  /** 是否「疑似已放弃」：玩过、超过 STALE_DAYS 没启动、还没被用户处理过 */
  function isStale(game) {
    if (!game) return false;
    if (game.status === STATUS.ABANDONED || game.status === STATUS.COMPLETED) return false;
    const d = daysSincePlayed(game);
    return d >= STALE_DAYS;
  }

  /**
   * 根据 Steam 数据推断状态的建议值。
   *
   * 优先级链（高 -> 低）：
   *   1. 锁定（statusLocked）     —— 在 mergeSteam 里拦截，不在此函数内处理
   *   2. **手动**挪进的放弃区     —— 同上，手动终态，本函数也**永远不返回**它
   *   3. 「归入已通关」的收藏夹 —— 只要在这分类里，就是已通关（归档，不看日期）
   *                                （具体是哪个分类名，看用户的设置）
   *   4. 全成就                   —— 同上，已通关是终态
   *   5. 「归入已放弃」的收藏夹 —— 放弃区（**不看**玩没玩过、多久没碰）
   *   6. 启动日期（90 天阈值）    —— ≤90 天 = 正在游玩；>90 天 = 已暂停
   *   7. 有近期时长但没启动时间戳 —— 同样算"在玩"（也算启动过的证据）
   *   8. 「归入待游玩」的收藏夹 —— 待游玩（**只对"从没启动过"的款生效**）
   *   9. 从未启动                 —— 停在总库，不参与日期归类
   *
   * 🔴 **第 5 条必须排在第 3/4 之后、第 6 之前**（2026-10-13）：
   *    · 排在**已通关之后** → 一款同时在「已完结」和「已放弃」里时**通关赢**。
   *      通关是终态（打完了就是打完了），放弃不是（移出收藏夹就能被放出来）。
   *    · 排在**日期规则之前** → 跟「待游玩」正好相反：收藏夹里写着"已放弃"
   *      就是放弃，不看它玩过多久、多久没碰。这正是这两格的分工。
   *
   * 🔴 **第 8 条必须排在第 6 条之后**（2026-10-13）。理由是这条收藏夹的定义：
   *    「待游玩」= **想玩但还没开始**。放在日期规则之前的话，一款你正在玩的
   *    游戏只要被拖进那个收藏夹，下一轮同步就会被拽出「正在游玩」——
   *    那是在跟用户对着干。排在后面就天然只接"从没启动过"的款：
   *    玩过的款在第 6 步就 return 了，根本走不到这里。
   *
   * 注意 1：hidden（工具隐藏）不在这里处理，隐藏优先级最高，
   *         在 mergeSteam 里用 isToolGame / inHiddenCollection 单独判定。
   * 注意 2：手动优先的细节（手动晚于启动则保留手动结果）也在 mergeSteam 里处理。
   */
  function suggestStatus(game) {
    // 3. 用户指定的「通关」收藏夹 —— 优先级高于全成就判断
    if (inCompletedCollection(game)) return STATUS.COMPLETED;

    // 4. 全成就 —— 已通关是归档终态，不再看启动日期
    const ach = game.achievements;
    const allDone = !!(ach && ach.total > 0 && ach.earned >= ach.total);
    if (allDone) return STATUS.COMPLETED;

    // 5. 「归入已放弃」的收藏夹 —— 直接进放弃区（不看日期、不看玩没玩过）。
    //    ⚠️ `wantsAbandon` 里含 `!abandonDismissed`：用户手动把它挪出放弃区过，
    //       只要款还留在那个收藏夹里，就不再自动塞回去。
    if (wantsAbandon(game)) return STATUS.ABANDONED;

    // 6. 按启动日期分流：近期玩过 -> 正在游玩，久未启动 -> 已暂停
    const days = daysSincePlayed(game);
    if (days >= 0) {
      if (days <= RECENT_DAYS) return STATUS.PLAYING;
      return STATUS.PAUSED;
    }

    // 7. 有近期时长但没启动时间戳 —— 同样算"在玩"（也算启动过的证据）
    if (game.recentMinutes > 0) return STATUS.PLAYING;

    // 8. 「归入待游玩」的收藏夹 —— 走到这里说明**从没启动过**，正是待玩清单接的人
    if (inBacklogCollection(game)) return STATUS.BACKLOG;

    // 9. 从未启动（也没有 recentMinutes）：停在总库，等用户自己决定
    return STATUS.LIBRARY;
  }

  /** 全成就判断（供 UI 挂勋章） */
  function isPerfect(game) {
    const ach = game.achievements;
    return !!(ach && ach.total > 0 && ach.earned >= ach.total);
  }

  /**
   * 「我的游戏单」卡片右下角那个角标该显示什么。
   *
   * 返回 'owned'（已拥有）/ 'wish'（未入库）/ 'family'（家人拥有）/ ''（不挂角标）。
   *
   * ⚠️ 判断依据是 **source 而不是「有没有时长」**：库里从没启动过的游戏
   * 时长同样是 0，用它判断会把一大堆已拥有的游戏标成「未入库」。
   *
   * 手动添加的游戏（source='manual'）**故意不挂角标**：它既可能是你拥有的、
   * 也可能不是，Steam 那边没有依据 —— 标错比不标更糟。
   * 它一旦跟 Steam 库对上号（填了 appid 且那款在库里），mergeSteam 会把
   * source 改成 'steam'，那时自然就显示「已拥有」了。
   *
   * 「家人拥有」单独一类（不是「已拥有」的变体）：它是**别人的**游戏，
   * 混进「已拥有」会让库容量、总时长这些数全部失真。
   *
   * ⚠️ **非默认平台（EPIC）刻意不挂角标**（走到最后的空返回）。理由：
   *    那个平台的整份库**每一款都是已拥有**（拿到的是它的权益目录），
   *    「已拥有」四个字在该标签页里等于每张卡都一样 —— 挂上去只是噪音。
   *    真正有信息量的是"装没装"，那个走卡面上的**已安装**标记
   *    （见 ui.js 里按 `installed` 能力决定的那一格），不是这里的角标。
   *    ⇒ 别为了让这里"看起来完整"给它补一个分支，那会把噪音加回来。
   */
  function ownershipOf(game) {
    if (!game) return '';
    if (game.source === 'steam') return 'owned';
    if (game.source === 'wishlist') return 'wish';
    if (game.source === 'family') return 'family';
    return '';
  }

  // ===== 存储层：优先 IndexedDB，失败降级 localStorage =====
  const DB_NAME = 'gamevault';
  const DB_VERSION = 1;
  const STORE = 'games';
  const LS_KEY = 'gamevault_games';

  let dbPromise = null;

  // IndexedDB 的 open 在某些环境（无头浏览器、隐私模式、企业策略）会
  // 永远不回调也不报错。加超时兜底，超时后降级到 localStorage。
  const IDB_TIMEOUT = 2500;

  function withTimeout(promise, ms, tag) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout: ' + tag)), ms)
      )
    ]);
  }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!global.indexedDB) { reject(new Error('no indexedDB')); return; }
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('idb open timeout')); }
      }, IDB_TIMEOUT);

      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('appid', 'appid', { unique: false });
          os.createIndex('status', 'status', { unique: false });
        }
      };
      req.onsuccess = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(req.result);
      };
      req.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(req.error || new Error('idb open failed'));
      };
      req.onblocked = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('idb blocked'));
      };
    });
    // 失败时清掉缓存的 promise，允许后续重试
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  async function idbAll() {
    const db = await openDB();
    return withTimeout(new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error || new Error('idb read aborted'));
    }), IDB_TIMEOUT, 'idbAll');
  }

  async function idbPutMany(list) {
    const db = await openDB();
    return withTimeout(new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const os = tx.objectStore(STORE);
      list.forEach(g => os.put(g));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('idb write aborted'));
    }), 8000, 'idbPutMany');
  }

  async function idbDelete(id) {
    const db = await openDB();
    return withTimeout(new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('idb delete aborted'));
    }), IDB_TIMEOUT, 'idbDelete');
  }

  // localStorage 降级
  // 注意：localStorage 通常只有 5MB。约 400 款游戏的精简数据约 200KB，
  // 能装下；但若用户手写大量感想可能接近上限，所以裁剪掉可从 Steam 重取的字段。
  const LS_LIGHT_FIELDS = ['header', 'releaseDate', 'genres', 'developers', 'icon'];

  function lighten(list) {
    return list.map(g => {
      const c = Object.assign({}, g);
      // 只保留必要字段，图片等可从 Steam 重新同步
      LS_LIGHT_FIELDS.forEach(k => { if (k in c) c[k] = ''; });
      if (Array.isArray(c.genres)) c.genres = [];
      if (Array.isArray(c.developers)) c.developers = [];
      return c;
    });
  }

  function lsAll() {
    try {
      const s = global.localStorage.getItem(LS_KEY);
      return s ? JSON.parse(s) : [];
    } catch (e) { return []; }
  }
  function lsSave(list) {
    try {
      global.localStorage.setItem(LS_KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      // 配额爆了：先尝试裁剪字段，仍然失败就放弃
      try {
        global.localStorage.setItem(LS_KEY, JSON.stringify(lighten(list)));
        return true;
      } catch (e2) {
        console.error('localStorage 写入失败（配额不足）', e2);
        return false;
      }
    }
  }
  let useLS = false;

  // 支持用 URL 参数强制走 localStorage：
  //   index.html?storage=local
  // 用于排障（IndexedDB 被浏览器策略禁用时）和自动化测试。
  try {
    if (global.location && /[?&]storage=local\b/.test(global.location.search)) {
      useLS = true;
    }
  } catch (e) { /* ignore */ }

  // ===== 对外 API =====
  const DataStore = {
    STATUS,
    STATUS_META,
    VIEW_ORDER,
    makeGame,
    suggestStatus,
    isPerfect,
    ownershipOf,
    RECENT_DAYS,
    STALE_DAYS,
    daysSincePlayed,
    isStale,
    isToolGame,
    inCompletedCollection,
    inBacklogCollection,
    inAbandonedCollection,
    wantsAbandon,
    inHiddenCollection,
    adoptLegacyCollection,

    // 收藏夹 -> 状态的映射由用户自己定（见文件顶部 PREFS_KEY 那段）
    getPrefs,
    setPrefs,
    defaultPrefs,
    collectionsInData,
    duplicateCollections,
    tsToDate,
    yearOf,
    // 通关年份（年表的依据）：字段语义与三条规则见上面的 `DONE_UNKNOWN` 那段
    DONE_UNKNOWN,
    doneYearOf,
    touchDoneAt,
    setDoneYear,
    backfillDoneAt,
    // 玩家评测的写入口（专用 setter，只动 steamReview / steamReviewAt / steamReviewMeta）
    setReview,
    setReviewsBulk,
    minutesToHours,
    parseReleaseYear,
    uid,

    /** 当前是否在用降级的 localStorage（IndexedDB 不可用时为 true） */
    get isFallback() { return useLS; },

    /** 主动探测一次存储是否可用（供 UI 显示状态） */
    async probe() {
      try {
        await idbAll();
        return 'idb';
      } catch (e) {
        useLS = true;
        return 'ls';
      }
    },

    async all() {
      if (!useLS) {
        try { return await idbAll(); }
        catch (e) { useLS = true; }
      }
      return lsAll();
    },

    async saveMany(list) {
      if (!useLS) {
        try { return await idbPutMany(list); }
        catch (e) { useLS = true; }
      }
      const cur = lsAll();
      const map = new Map(cur.map(g => [g.id, g]));
      list.forEach(g => map.set(g.id, g));
      return lsSave(Array.from(map.values()));
    },

    async save(game) {
      game.updatedAt = Date.now();
      return this.saveMany([game]);
    },

    async remove(id) {
      if (!useLS) {
        try { return await idbDelete(id); }
        catch (e) { useLS = true; }
      }
      return lsSave(lsAll().filter(g => g.id !== id));
    },

    async clear() {
      if (!useLS) {
        try {
          const db = await openDB();
          await withTimeout(new Promise((res, rej) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).clear();
            tx.oncomplete = () => res(true);
            tx.onerror = () => rej(tx.error);
            tx.onabort = () => rej(tx.error || new Error('clear aborted'));
          }), IDB_TIMEOUT, 'idbClear');
          return true;
        } catch (e) { useLS = true; }
      }
      return lsSave([]);
    },

    /**
     * 合并一捆**非默认平台**的同步结果（EPIC 走这条；以后接第三个平台也是这条）。
     *
     * 🔴 为什么不写进 `mergeSteam` 里加几个 if：
     *    那条链上一多半规则是 **Steam 独有**的 —— 按收藏夹名判「已通关」、按全成就归档、
     *    按 `lastPlayedTs` 的 90 天分流、愿望单转正、家庭款的粘性……
     *    而这些字段别的平台**根本没有**（EPIC 连"最后游玩时间"都不存在）。
     *    在那条链上加分支，代价不是"多打几个 if"，而是**每个 if 都要多问一次
     *    "这对别的平台成立吗"** —— 而其中大半只在 Steam 上成立。
     *
     * 规则（刻意比 mergeSteam 少得多）：
     *   · 归属看 `platform`，判据走 `GVPlatforms.of`（唯一判据，别在这儿再写一份）
     *   · 键 = **平台 + appid**，不是裸 appid —— 两个平台的 id 空间毫无关系，
     *     只按 appid 认会被"恰好同名"的键串起来，而且这种错**不会报错**
     *   · 已存在 → 只更新**平台侧**字段（标题 / 封面 / 安装状态 / 开发商 / 发售日）；
     *     用户侧字段（状态 / 感想 / 锁定 / 收藏 / 隐藏）一律不动
     *   · 新建 → 状态交给 `suggestStatus`。对没有"最后游玩时间"的平台，它天然只
     *     返回「我的游戏单」—— **那不是退化，那就是事实**
     *   · 🔴 **已存在的记录不改状态**。这些平台给不出任何日期，应用对"它现在该算
     *     哪个区块"**没有新信息**；此时重算的唯一效果是把用户自己摆好的位置推回默认。
     *     Steam 那边敢每次重算，是因为它每次都带着新的 `lastPlayedTs` / 收藏夹。
     */
    async mergePlatform(incoming) {
      const existing = await this.all();
      const byKey = new Map();
      existing.forEach(g => {
        if (g.appid == null) return;
        byKey.set(GVPlatforms.of(g) + '|' + String(g.appid), g);
      });

      const toSave = [];
      let added = 0, updated = 0, skipped = 0;

      (incoming || []).forEach(src => {
        if (!src || src.appid == null) return;
        const plat = GVPlatforms.of(src);
        // 默认平台的记录有它自己那条更细的路径，这里不抢（抢了会绕过收藏夹 / 全成就归类）
        if (plat === GVPlatforms.DEFAULT_ID) { skipped++; return; }
        const key = plat + '|' + String(src.appid);
        const old = byKey.get(key);

        if (old) {
          // ⚠️ 一律"**有才写**"，不是 `src.title || old.title`。后者看着等价，
          //    实际会把"这次没拿到标题"当成"标题是空的"写进去 —— 一次性清掉一片名字。
          if (src.title) old.title = src.title;
          if (src.header) old.header = src.header;
          if (src.icon) old.icon = src.icon;
          if (src.developers && src.developers.length) old.developers = src.developers;
          if (src.releaseDate) {
            old.releaseDate = src.releaseDate;
            if (!old.releaseYear) old.releaseYear = parseReleaseYear(src.releaseDate);
          }
          if (src.coverKind) old.coverKind = src.coverKind;
          if (src.epicAppName) old.epicAppName = src.epicAppName;
          if (src.epicId) old.epicId = src.epicId;
          if (typeof src.installed === 'boolean') old.installed = src.installed;
          if (src.installSize) old.installSize = src.installSize;
          // 身份原样保留（平台 + 它自己那个 source），只防"被别的路径洗过"
          old.platform = plat;
          if (src.source) old.source = src.source;
          old.updatedAt = Date.now();
          toSave.push(old);
          updated++;
          return;
        }

        const g = makeGame({
          appid: src.appid,
          platform: plat,
          source: src.source || 'manual',
          title: src.title || '',
          developers: Array.isArray(src.developers) ? src.developers.slice() : [],
          releaseDate: src.releaseDate || '',
          releaseYear: parseReleaseYear(src.releaseDate),
          installed: !!src.installed,
          installSize: src.installSize || 0,
          epicAppName: src.epicAppName || '',
          epicId: src.epicId || '',
          coverKind: src.coverKind || ''
        });
        // 封面「有才写」：写成空串会把 `src.header || old.header` 那条路堵死
        if (src.header) g.header = src.header;
        if (src.icon) g.icon = src.icon;
        g.status = suggestStatus(g);
        g.autoStatus = g.status !== STATUS.LIBRARY;
        toSave.push(g);
        added++;
      });

      await this.saveMany(toSave);
      return { added, updated, skipped };
    },

    /**
     * 只补**公共资料**（名字 / 封面 / 发售年 / 类型 / 开发商）—— 绝不碰身份。
     *
     * 🔴🔴 为什么必须有这个函数（2026-10-10，用户实测投诉「愿望单里的游戏卡右下角
     *    标成了『已拥有』，可我一款都没买」）：
     *
     *    `local-src.js` 的 `fillMeta()`（补商店资料的每一步）以前是直接调
     *    `mergeSteam()` 写回的，而 `mergeSteam` 对**已存在的记录**会无条件执行
     *    `old.source = staysFamily ? 'family' : 'steam'` —— 它只保护 family。
     *    可 `fillMeta` 构造的记录里**根本没有 `source` 字段**（它只知道 appid 和
     *    几个资料字段），于是：**凡是它补过资料的记录，来源一律被改成 'steam'**，
     *    角标随之变成「已拥有」。
     *
     *    而愿望单刚导进来的款**正是它补得最凶的那一批**：愿望单接口只给 appid、
     *    不给名字（见 mergeWishlist 的说明），于是它们既不满足 `fillMeta` 那条
     *    「有名字有封面就跳过」的守卫，还正好落在 `fillMetaInBackground` 排在
     *    第一档的「没名字的」里，并且每次同步给足 240 个额度、每次启动再补 45 个。
     *
     *    实测：`source:'steam'` 的记录数**远多于**「账号侧拥有 ∪ 本机读到的」
     *    —— 多出来的全是愿望单里的款被转正的；界面上「已拥有」的数量
     *    = 前者 + 手动录入的那几条，与用户截图逐字吻合。
     *
     *    所以补资料这条路**必须和「库同步」彻底分开**：它没有任何资格改变一条
     *    记录的身份、状态、收藏夹或时长 —— 它只知道"这款在商店里叫什么、哪年出的"。
     *
     * ## 与 `mergeSteam` 的分工（别再合并回去）
     *
     * `mergeSteam` = 「**我的库**里有什么」—— 它有资格写 source / collections / 时长 /
     * 状态归类，因为它拿到的 payload 本身就是一份拥有凭证。
     * 本函数 = 「商店怎么说这款」—— **一个字段都不许越界**。
     *
     * ## 规则（刻意少，且都是"只补缺"）
     *
     *  · 按 **(平台, appid)** 定位已有记录；**找不到就什么都不做**（绝不新建 ——
     *    以前那条路会因为 EPIC 记录不在默认平台索引里，把同一款**又建一条**出来，
     *    实测 4 条记录变 5 条）。
     *  · 只写白名单字段，且**只在当前为空时**写：`title / icon / header /
     *    releaseDate / releaseYear / genres / developers`。
     *    口径与 mergeSteam 一致（`src.x || old.x`），这样"本机那张离线可用的本地
     *    封面"不会被商店的远程图盖掉。
     *  · **一个字都不写**：`source` / `status` / `autoStatus` / `manualStatus` /
     *    `statusLocked` / `collections` / `totalMinutes` / `recentMinutes` /
     *    `lastPlayedTs` / `achievements` / `doneAt` / `wish*`。
     *
     * :param incoming [{appid, title?, header?, …}, …]
     * :returns {asked, filled}（`filled` = 真的写进内容的条数）
     */
    async mergeMeta(incoming) {
      const list = Array.isArray(incoming) ? incoming : [];
      if (!list.length) return { asked: 0, filled: 0 };

      const existing = await this.all();
      const byKey = new Map();
      existing.forEach(g => {
        if (!g || g.appid == null) return;
        byKey.set(GVPlatforms.of(g) + ':' + String(g.appid), g);
      });

      const toSave = [];
      let asked = 0, filled = 0;

      list.forEach(src => {
        if (!src || src.appid == null) return;
        asked++;
        // ⚠️ 键里带平台：`/api/steam/store` 查的是 Steam 商店，它的答案只对
        //    默认平台的那条记录有效。这样 EPIC 记录天然落不进来（不写、不新建）。
        const g = byKey.get(GVPlatforms.DEFAULT_ID + ':' + String(src.appid));
        if (!g) return;

        const hasG = Array.isArray(g.genres) && g.genres.length > 0;
        const hasD = Array.isArray(g.developers) && g.developers.length > 0;
        let touched = false;
        const put = (field, val) => { g[field] = val; touched = true; };

        if (!g.title && src.title) put('title', src.title);
        if (!g.icon && src.icon) put('icon', src.icon);
        if (!g.header && src.header) put('header', src.header);
        if (!g.releaseDate && src.releaseDate) put('releaseDate', src.releaseDate);
        if (!g.releaseYear && src.releaseYear) put('releaseYear', src.releaseYear);
        if (!hasG && src.genres && src.genres.length) put('genres', src.genres);
        if (!hasD && src.developers && src.developers.length) put('developers', src.developers);

        if (touched) { g.updatedAt = Date.now(); toSave.push(g); filled++; }
      });

      if (toSave.length) await this.saveMany(toSave);
      return { asked: asked, filled: filled };
    },

    /**
     * 合并一捆 Steam 同步结果。
     * 规则：
     *  - appid 已存在 -> 更新 Steam 侧字段（时长/成就/最后游玩），保留用户侧字段（状态/备注/评价）
     *  - appid 不存在 -> 新建
     *  - 用户手动设过状态的，状态不被覆盖
     *  - 「已隐藏」收藏夹里的游戏强制隐藏（优先级高于一切）
     *  - 用户指定的「通关」收藏夹里的游戏自动进「已通关」
     *  - 升级上来的老数据：见到旧版写死的分类名就沿用（见 adoptLegacyCollection）
     */
    async mergeSteam(incoming) {
      // 🔴 先把**别的平台**的记录摘出去，交给 mergePlatform。
      //
      //    为什么这里非有这一步不可：**备份导入走的就是这个函数**
      //    （`ui.js` 的 `importBackupFile`），而导出的文件里逐条带着 `platform` 字段。
      //    不摘的话，下面那句 `old.source = 'steam'` 会把 EPIC 的记录一起改成
      //    "已拥有"，而**再也没有任何东西能把它们改回去** —— EPIC 每次同步只认
      //    自己那几条（`source='epic'`），被改错的它一个都不认得。
      //    "导出再导入一次，别的平台的记录全变了样"是最难查的一类回归。
      const all = Array.isArray(incoming) ? incoming : [];
      const mine = [], others = [];
      all.forEach(r => {
        if (r && GVPlatforms.of(r) !== GVPlatforms.DEFAULT_ID) others.push(r);
        else mine.push(r);
      });
      const other = others.length
        ? await this.mergePlatform(others)
        : { added: 0, updated: 0, skipped: 0 };

      const existing = await this.all();
      const byAppid = new Map();
      // ⚠️ 索引里**只放默认平台**的记录。按裸 appid 认本来就不该跨平台，
      //    这一步把"两个平台的 id 恰好同名"这种将来可能出现的坑提前堵掉。
      existing.forEach(g => {
        if (g.appid == null) return;
        if (GVPlatforms.of(g) !== GVPlatforms.DEFAULT_ID) return;
        byAppid.set(String(g.appid), g);
      });

      // 老用户升级上来的第一趟：数据里（不管是库里已有的还是这次喂进来的）
      // 带着旧版写死的分类名就一并认下来，否则「已通关」会整体回退。
      // 只认一次，且用户改过设置就不动。
      adoptLegacyCollection(existing.concat(mine));

      const toSave = [];
      let added = 0, updated = 0, recollected = 0, locked = 0, abandoned = 0;

      mine.forEach(src => {
        const key = String(src.appid);
        const old = byAppid.get(key);
        if (old) {
          old.title = src.title || old.title;
          old.icon = src.icon || old.icon;
          old.header = src.header || old.header;
          old.totalMinutes = src.totalMinutes ?? old.totalMinutes;
          old.recentMinutes = src.recentMinutes ?? old.recentMinutes;
          old.lastPlayedTs = src.lastPlayedTs || old.lastPlayedTs;
          if (src.achievements) old.achievements = src.achievements;
          if (src.releaseYear && !old.releaseYear) old.releaseYear = src.releaseYear;
          if (src.releaseDate && !old.releaseDate) old.releaseDate = src.releaseDate;
          if (src.genres && src.genres.length && !old.genres.length) old.genres = src.genres;
          if (src.developers && src.developers.length && !old.developers.length) old.developers = src.developers;
          // 「这条记录原先只是愿望单里的」—— 必须在下面改 source 之前记下来，
          // 状态归类那边要靠它判断「刚刚买下、还没玩过」。
          const wasWishlistOnly = old.source === 'wishlist';
          // 🔴 **家庭款（source='family'）不许在这里被改成 'steam'**。
          //    mergeSteam 走的是「**我的**库」这条路，而家庭款是**别人的**游戏 ——
          //    「已拥有」角标、库容量统计全都靠 source 判，改错就是几百款凭空多出来
          //    （实测家庭并集数百款）。
          //    ⚠️ 这条不是理论风险：**备份导入**（`importBackupFile`）就是调这个函数，
          //    导出过的备份里带着 `source:'family'`，旧写法无条件 `old.source='steam'`
          //    会让"导出再导入一次"就把家庭款全部变成「已拥有」。
          //    判据用 `src.source`（备份文件里带着这个字段）；
          //    本机/联网/愿望单那几条路喂进来的记录**都不带 source**，不受影响。
          //
          //    ⚠️⚠️ **已知限制（不是设计）**：`old.source === 'family'` 这一半是**粘性**的
          //    —— 一款先作为「家人拥有」进来的游戏，在你**真的买下它之后**也不会自动
          //    转成「已拥有」（虽然愿望单那条路会转）。原因：在 `mergeSteam` 这一层
          //    分不清"这款出现在库里是因为**我买了**"还是"因为**共享来的副本装在我盘上**"
          //    —— 后者也会被 `/api/local/library` 读到，一刀切转正会把几百款家人的游戏
          //    标成你的（比不转正糟得多）。要修得先给"这条payload确实是我的账号库"
          //    加一个显式信号（联网那条路加得动，本机那条加不动），属独立改动。
          //    眼下**宁可少标，不可错标**。
          const staysFamily = old.source === 'family' || src.source === 'family';
          old.source = staysFamily ? 'family' : 'steam';
          if (staysFamily) {
            // 🔴 身份是"家人拥有"时，三个「我的」字段一律归零 —— **不管文件里写了什么**。
            //    不能只依赖"上游从来没写过脏值"：那是个会被下一次改动打破的假设
            //    （云端表里连 `familyOwners` 这两列都没有，见 DESIGN.md 的已知限制）。
            //    放在这里是因为上面 694~696 行已经写过了，这里把它盖回去。
            old.totalMinutes = 0;
            old.recentMinutes = 0;
            old.lastPlayedTs = 0;
          }
          // 收藏夹：每次同步都覆盖（用户可能在 Steam 里改了分类）
          if (Array.isArray(src.collections)) old.collections = src.collections;
          old.updatedAt = Date.now();

          // 🔴 必须在下面那段**之前**记下"这次同步之前它是不是已通关" ——
          //    通关年份要靠这个区分「这次刚归入」（写此刻）与「本来就已通关、只是补字段」
          //    （写最后游玩时间）。状态块里 `wasCompleted` 是块作用域的，出了块就取不到。
          const statusBefore = old.status;

          // ===== 状态归类 =====
          // 优先级（高 -> 低）：
          //   1. 锁定（statusLocked）        -> 一律不动
          //   2. **手动**挪进的放弃区         -> 手动终态，一律不动
          //   3. 已通关（收藏夹 / 全成就）   -> 归档终态，不受日期影响
          //   4. 收藏夹「已放弃」            -> 放弃区（**排在已通关之后** = 通关赢）
          //   5. 手动改状态晚于上次启动      -> 尊重手动结果
          //   6. 启动日期（90 天阈值）       -> 正在游玩 / 已暂停
          //   7. 尚未启动                    -> 看「待游玩」收藏夹 / 停在总库
          if (old.statusLocked) {
            // 锁定的游戏：状态一动不动，连「已通关」也不重算
            locked++;
          } else if (old.status === STATUS.ABANDONED &&
                     old.abandonedBy !== 'collection') {
            // **手动**挪进放弃区的 = 手动终态，和锁定同级：
            // 「不打算再玩了」只有用户能判断，所以同步时一律不动 ——
            // 包括不被「通关」收藏夹 / 全成就拉回「已通关」，
            // 也不因为"后来又启动了一次"被日期规则挪去「正在游玩」。
            // 想让它回到别的状态，手动改一下即可（改完就不再是 abandoned）。
            //
            // ⚠️ 只有 `abandonedBy === 'collection'`（**收藏夹自动**放进去的）才继续
            //    往下走 —— 那批是"可撤销"的：把款移出「已放弃」收藏夹，下次同步
            //    就放它回自动规则（见下面那段「释放」分支）。
            old.autoStatus = false;
            abandoned++;
          } else {
            const wasCompleted = old.status === STATUS.COMPLETED;
            const shouldCompleted = inCompletedCollection(old) ||
                                    isPerfect(old);   // 收藏夹 或 全成就
            const completedDismissed = shouldCompleted && !wasCompleted &&
                                       old.dismissedCollection &&
                                       !inCompletedCollection(old);
            // 手动改状态是否晚于上次启动？（手动后没再启动过 -> 保留手动结果）
            const manualWins = !!old.manualStatus &&
                               (old.statusManualAt || 0) > (old.lastPlayedTs || 0);
            // 「已放弃」收藏夹里有没有它 + 该不该自动判成放弃
            // （用户手动挪走过就不再塞回去 —— 见 wantsAbandon）
            const wantAbandon = wantsAbandon(old);

            if (manualWins) {
              // 手动优先：状态保持不动
              old.autoStatus = false;
            } else if (wantAbandon && !shouldCompleted) {
              // 🔴 收藏夹说"不玩了" -> 直接进放弃区。
              //    · 排在**已通关之后**：同时命中「已完结」与「已放弃」时**通关赢**
              //      —— 通关是终态，放弃不是。
              //    · 排在**日期规则之前**：跟「待游玩」正好相反 —— 这一款
              //      不管玩没玩过、多久没碰，都算放弃。
              old.status = STATUS.ABANDONED;
              old.autoStatus = false;
              abandoned++;
            } else if (!wantAbandon && old.status === STATUS.ABANDONED &&
                       old.abandonedBy === 'collection') {
              // **释放** —— 上一轮是收藏夹把它自动放进去的，这一轮它已经不在那个
              //    收藏夹里（或用户已手动挪走过）-> 放它回自动规则。
              //
              // ⚠️ 这段**不是**"能出来"的承重实现（2026-10-13 用改坏法实测过，别照
              //    旧注释理解）：把它整个删掉，`_t_collection.html` 仍然 60/0 全绿 ——
              //    因为紧接着的兜底 `else`（下面那个"普通游戏：按启动日期自动分流"）
              //    对 `status===ABANDONED` 这个前提做的事**逐字相同**（同样的
              //    `suggestStatus` -> 赋值 -> 同样的 autoStatus 判据），而夹在中间那几条
              //    `shouldCompleted/wasCompleted` 分支对"当前是放弃区"的款也都不成立。
              //    真正承重的是上面那段「放弃区收口」写下的 `abandonedBy` 标记：
              //    只把收口改坏（分支留着）-> P14l 精确变红，自动进来的款再也放不出来。
              //
              //    留着这一段是为了**不依赖那个巧合**：将来若有人在兜底 else 之前插入
              //    新分支、或改动兜底的语义，释放行为会跟着静默变掉。这里显式写出来，
              //    读的人一眼看到"移出即放回"是条独立规则，而不是兜底的副作用。
              const s = suggestStatus(old);
              old.status = s;
              old.autoStatus = (s === STATUS.PLAYING || s === STATUS.PAUSED);
            } else if (shouldCompleted && !wasCompleted && !completedDismissed) {
              // 被收藏夹/全成就拉回「已通关」
              old.status = STATUS.COMPLETED;
              old.autoStatus = false;
              recollected++;
            } else if (wasCompleted && !shouldCompleted && !old.dismissedCollection) {
              // 曾经通关但已不在收藏夹、也丢了全成就 -> 交给自动规则
              const s = suggestStatus(old);
              old.status = s;
              old.autoStatus = (s === STATUS.PLAYING || s === STATUS.PAUSED);
            } else if (wasCompleted) {
              // 已通关是归档终态，不动
              old.autoStatus = false;
            } else {
              // 刚好从愿望单买下、而且一次都还没启动过 -> **留在「待游玩」**。
              // 「买了」不等于「开始玩了」：让它在待玩清单里等你亲自开，
              // 而不是悄无声息掉进总库 —— 用户的预期是「我刚买的那个应该
              // 还躺在我待玩列表里」。一旦真的启动过（lastPlayedTs 有值），
              // 这条分支就不成立，会走下面的正常分流。
              if (wasWishlistOnly && old.status === STATUS.BACKLOG && !old.lastPlayedTs) {
                old.status = STATUS.BACKLOG;
                old.autoStatus = false;
              } else {
                // 普通游戏：按启动日期自动分流
                const s = suggestStatus(old);
                old.status = s;
                old.autoStatus = (s === STATUS.PLAYING || s === STATUS.PAUSED);
              }
            }

            // ===== 放弃区收口 =====
            // 和上面 doneAt 那段同一个道理：只在这一处写，免得每条分支各写一遍
            // （漏一处 = 那条路径进来的款永远卡在放弃区 / 或者被当成手动终态）。
            //   · 最终是「放弃区」且它确实在「已放弃」收藏夹里 -> 打上来源标记。
            //     🔴 这是整个功能里最要紧的一个不变量：少了这个标记，自动放进来的
            //        款会被当成**手动终态**，把它移出收藏夹也放不出来 —— 死胡同。
            //   · 最终不是放弃区 -> 标记清空（`abandonedBy` 只对放弃区有意义）。
            if (old.status === STATUS.ABANDONED) {
              if (inAbandonedCollection(old)) old.abandonedBy = 'collection';
            } else {
              old.abandonedBy = '';
            }
            // 离开收藏夹 = 上一轮那次「别再塞回去」作废：以后再放进去要重新生效
            if (!inAbandonedCollection(old)) old.abandonDismissed = false;
          }

          // 通关年份：上面整个状态块里**所有**"判为已通关"的分支都从这里收口 ——
          // 只在这一处补，避免三处分头写（漏一处 = 那条路径进来的款永远没有年份）。
          // ⚠️ 收口点必须在状态块**之后**：块内早期分支还会把状态改掉（例如
          //    「曾通关但已不在收藏夹」会交给自动规则），提前写就会给一款
          //    最终不算已通关的款留下年份。
          if (old.status === STATUS.COMPLETED && !old.doneAt) {
            if (statusBefore === STATUS.COMPLETED) {
              // 本来就已通关、只是缺字段（老数据）→ 与 backfillDoneAt 同口径
              touchDoneAt(old, old.lastPlayedTs);
            } else {
              // 这次刚归入（收藏夹 / 全成就）→ "归入的那一刻"就是现在
              touchDoneAt(old, Math.floor(Date.now() / 1000));
            }
          }

          // 隐藏：工具/软件 or「已隐藏」收藏夹
          if (!old.manualHidden) {
            old.hidden = inHiddenCollection(old) || isToolGame(old);
          } else if (inHiddenCollection(old)) {
            old.hidden = true;   // 「已隐藏」收藏夹优先级最高，覆盖手动取消隐藏
          }
          toSave.push(old);
          updated++;
        } else {
          const g = makeGame(Object.assign({}, src, {
            status: src.suggestedStatus || suggestStatus(src),
            // 家庭款从备份导入时**保持自己的身份**（理由见上面那段注释）
            source: src.source === 'family' ? 'family' : 'steam'
          }));
          if (g.source === 'family') {
            // 🔴 家人的时长 / 启动时间**永远不许**落进"我的"字段 ——
            //    「总时长」「玩过」这些统计直接读 totalMinutes，
            //    混进别人的游玩记录，库里的数字就再也说不清是谁的。
            g.totalMinutes = 0;
            g.recentMinutes = 0;
            g.lastPlayedTs = 0;
          }
          // 通关年份：**新建分支同样要收口**（备份导入、首次同步都会走到这里）。
          // ⚠️ 备份文件里带 `doneAt` 的**原样保留** —— `makeGame` 是
          //    `Object.assign(默认值, partial)`，`src.doneAt` 会盖过默认值，
          //    换机器搬数据不许把年份搬丢；只有确实没有（旧备份 / 脚本生成的文件）
          //    才按 `lastPlayedTs` 推一次。
          if (g.status === STATUS.COMPLETED && !g.doneAt) {
            touchDoneAt(g, g.lastPlayedTs);
          }
          delete g.suggestedStatus;   // 内部字段，不入库
          if (!Array.isArray(g.collections)) g.collections = [];
          // 标记这条状态是不是自动规则产生的（供 UI 打「自动」角标）
          g.autoStatus = (g.status === STATUS.PLAYING || g.status === STATUS.PAUSED);
          // 放弃区：新建时就判成放弃区的，标上来源 —— 少了它，这款会被当成
          // 手动终态，以后把它移出「已放弃」收藏夹也放不出来。
          // ⚠️ 只在"状态是这次算出来的"时标：备份文件带 `suggestedStatus` 进来时，
          //    `src.abandonedBy` 已经被 makeGame 的 Object.assign 原样保留了，
          //    覆盖它会把**手动**终态的款错标成可释放的。
          if (!src.suggestedStatus && g.status === STATUS.ABANDONED) {
            g.abandonedBy = 'collection';
          }
          g.hidden = inHiddenCollection(g) || isToolGame(g);
          toSave.push(g);
          added++;
        }
      });

      await this.saveMany(toSave);
      // 别的平台那半的计数**并入同一个返回**：导入是一条动作、一份回执，
      // 分开报的话用户看到的是"新增 120 款"，而他一共导进来 180 款。
      return {
        added: added + other.added,
        updated: updated + other.updated,
        recollected, locked, abandoned
      };
    },

    /**
     * 合并一次「家庭库」抓取结果 —— 家庭成员**公开的**库里的那些款。
     *
     * 🔴 **为什么不能复用 `mergeSteam`**：那个函数放到这个场景里是**破坏性**的 ——
     *    · `old.source = 'steam'` → 家人的游戏会挂上「**已拥有**」角标，这是骗人；
     *    · `old.totalMinutes = src.totalMinutes ?? old.totalMinutes` → 同一个 appid
     *      我玩了 20 小时、家人玩了 800 小时，**我那份会被静默改成 800**
     *      （实测家庭并集和我自己的库重合 258 款，走错一步就是几百条真实时长被改）；
     *    · 还会跑一整套状态归类链（已通关收藏夹 / 全成就 / 90 天启动日期），
     *      而家庭库**既给不出收藏夹、也给不出我的启动时间** → 状态必算错。
     *
     * 所以这条路**独立一整套**，规则只有两条：
     *
     *   ① 我库里**没有**的 appid → 新建，`source:'family'`，状态停在「我的游戏单」；
     *      家人的时长记在**独立字段** `familyMinutes`（`totalMinutes` 保持 0）。
     *   ② 我库里**已经有的** appid → **原样不动**，连 `familyOwners` 都不写。
     *      理由：那些款的「我拥有 / 我玩多久 / 什么状态」已经全是对的，
     *      为了标一句"家人也有这款"去动 258 条真实记录，风险远大于收益。
     *      ⚠️ 它**不会**因为你后来买了同一款就自动转正 —— 见 mergeSteam 里
     *      `staysFamily` 那段「已知限制」。
     *
     * ⚠️ 去重在这里做**第二遍兜底**：同一款可能被多个成员拥有，调用方应当合成一条
     *    （带多个 `familyOwners`）；万一没合成，这里也不会写两条同 appid 的记录。
     */
    async mergeFamily(incoming) {
      const existing = await this.all();
      const seen = new Set();
      existing.forEach(g => { if (g.appid != null) seen.add(String(g.appid)); });

      const toSave = [];
      let added = 0, skipped = 0;

      (incoming || []).forEach(src => {
        if (!src || src.appid == null) return;
        const key = String(src.appid);
        // ② 我库里已有 → 不碰（已拥有的、愿望单的、手动加的，全都算"已有"）
        if (seen.has(key)) { skipped++; return; }
        const owners = Array.isArray(src.familyOwners) ? src.familyOwners.slice() : [];
        if (!owners.length) return;
        const g = makeGame({
          appid: src.appid,
          title: src.title || '',
          icon: src.icon || '',
          source: 'family',
          status: STATUS.LIBRARY,
          familyOwners: owners,
          familyMinutes: src.familyMinutes || 0,
          // 🔴 这里**故意不写** totalMinutes / recentMinutes / lastPlayedTs /
          //    collections / header：前三个是"我的"数据（必须保持 0 / 空），
          //    收藏夹只有本机那次同步写得了，封面交给 fillMeta 按部就班补。
        });
        // 工具 / 原声 / 专用服务器这类照老规矩默认隐藏 ——
        // 家庭并集里实测有一批（Steam Client、Dedicated Server、各类 Mod Tools），
        // 不藏起来会把总库冲得没法看。
        g.hidden = isToolGame(g);
        toSave.push(g);
        seen.add(key);          // ⚠️ 必须立刻加，否则同一款会被写两条
        added++;
      });

      await this.saveMany(toSave);
      return { added, skipped };
    },

    /**
     * 按当前偏好重跑一遍状态归类。
     *
     * 用户在「设置」里改了收藏夹名之后要调它 —— 状态是存在每条记录上的，
     * 光改偏好不会回头修正已经同步过的数据。
     *
     * 两条刻意的设计：
     *  1. **复用 mergeSteam 的优先级链**，不另写一套。再抄一遍那条链（锁定 /
     *     放弃终态 / 已通关 / 手动优先 / 日期分流）迟早会跟它不一致。
     *  2. **只跑 source === 'steam' 的记录**。mergeSteam 对已存在的记录会无条件
     *     写 `old.source = 'steam'`，把手动添加的（'manual'）一起喂进去，
     *     它们会莫名挂上「已拥有」角标 —— 而按约定 manual 是**不挂角标**的。
     *     愿望单记录（'wishlist'）同理排除，避免被当成刚买下重算一遍。
     */
    async reclassifyOwned() {
      const all = await this.all();
      const owned = all.filter(g => g && g.source === 'steam');
      if (!owned.length) return { added: 0, updated: 0, recollected: 0, locked: 0, abandoned: 0 };
      return this.mergeSteam(owned);
    },

    /**
     * 把「被错标成已拥有的愿望单款」修回「未入库」。**一次性数据修复。**
     *
     * 🔴 起因（2026-10-10）：`fillMeta()` 补资料时走的是 `mergeSteam`，而那个函数
     *    会把记录来源无条件改成 `'steam'`（只保护 family）→ 愿望单里的款被"转正"，
     *    角标变「已拥有」。源头已经改用 `mergeMeta` 堵住了（见那个函数的说明），
     *    但**已经被写坏的那批记录不会自己长回来**，光堵源头不够 ——
     *    所以要有这个函数。
     *
     * ## 判据（每一条都是"宁可少修，不可错修"）
     *
     * 一条记录**同时**满足下面全部条件才修：
     *  1. `wishlisted === true` —— 它此刻还在愿望单里（愿望单那一步写的身份）；
     *  2. `source === 'steam'` —— 它现在挂着「已拥有」；
     *  3. appid **不在 `ownedIds`**（Steam 账号侧全量库）里；
     *  4. appid **不在 `localIds`**（本机 Steam 文件读到的库）里；
     *  5. `totalMinutes === 0 && !lastPlayedTs && !achievements` —— 没有任何"玩过"的证据；
     *  6. `!statusLocked && !manualStatus && !favorite && !hidden && !doneAt`
     *     —— 用户从没亲手动过它。
     *
     * 🔴 **第 3、4 条是这个函数的命门，两条都少不得。** 实测（2026-10-10）：
     *    愿望单里有一批 `wishlisted && source==='steam'`，看上去都该修 ——
     *    但只用第 1、2 条去筛，会把那些**真的买了、真的在玩**的款也一起标成
     *    「未入库」（被误伤的既有单机大作、也有挂机上千小时的款）—— Steam 并不
     *    总是把已购的款从愿望单里移走（礼物、第三方 key、家庭共享都会留下）。
     *    加上第 3、4 条之后只剩原来的一小部分命中，而且这个值**与另一个独立算法
     *    算出的完全相同**（`source:'steam'` 的条数 − 「账号侧拥有 ∪ 本机读到的」
     *    条数）—— 两条互不相干的路径同值，这才是可信的判据。
     *
     * ## 为什么"有权拥有"要用两个集合
     *
     * `ownedIds` 来自联网那半（`/api/steam/library`），`localIds` 来自本机那半。
     * 少了任何一个，判据就会偏：只有 owned 的话，本机文件里那些"玩过但账号侧查不到"
     * 的款（家庭共享、装过别人号的副本）会被误修；只有 local 的话，本机没装的
     * "买了没碰过"的款会被误修。所以调用方**必须两个都给**。
     *
     * ## 空集合 = 拒绝执行
     *
     * 空数组会被理解成"你一款都没有" → 整库愿望单记录全被标回「未入库」。
     * 链路抖动完全可能给出空列表，所以这里**硬拒**（返回 `skipped`）。
     *
     * ## 顺带把掉出「待游玩」的款放回去
     *
     * 被转正的记录里有相当一部分**状态也被带歪了**：它们本来由
     * `mergeWishlist` 建在 `backlog`，被转正之后的下一次 `mergeSteam` 会走
     * 「普通游戏」那条分流，`suggestStatus()` 给出 `library` —— 于是它们既挂了
     * 「已拥有」、又从「待游玩」掉进了「我的游戏单」。
     * 同一个 bug 的两个后果，所以这里一起修：`status` 放回 `backlog`
     * （第 6 条守卫保证"只有用户没动过的"才动）。
     *
     * :param env {ownedIds:[…], localIds:[…]}  —— 两个都是 appid 数组
     * :returns {fixed, toBacklog, skipped?}
     */
    async reclassifyWishlistOnly(env) {
      const ownedL = env && env.ownedIds;
      const localL = env && env.localIds;
      if (!Array.isArray(ownedL) || !Array.isArray(localL)) return { fixed: 0, toBacklog: 0, skipped: 'no_sets' };
      // 🔴 空集合硬拒 —— 见上面那段。宁可这次不修，也不能拿"空"当"没有"。
      if (!ownedL.length || !localL.length) return { fixed: 0, toBacklog: 0, skipped: 'empty_set' };
      const owned = new Set(ownedL.map(String));
      const local = new Set(localL.map(String));

      const all = await this.all();
      const toSave = [];
      let fixed = 0, toBacklog = 0;

      all.forEach(g => {
        if (!g || g.appid == null) return;
        if (g.wishlisted !== true) return;              // ①
        if (g.source !== 'steam') return;               // ②
        const k = String(g.appid);
        if (owned.has(k)) return;                       // ③ 真的买了
        if (local.has(k)) return;                       // ④ 本机确实读得到
        if (g.totalMinutes > 0 || g.lastPlayedTs || g.achievements) return;   // ⑤
        if (g.statusLocked || g.manualStatus || g.favorite || g.hidden || g.doneAt) return;   // ⑥

        g.source = 'wishlist';
        fixed++;
        if (g.status !== STATUS.BACKLOG) {
          g.status = STATUS.BACKLOG;
          g.autoStatus = false;
          toBacklog++;
        }
        g.updatedAt = Date.now();
        toSave.push(g);
      });

      if (toSave.length) await this.saveMany(toSave);
      return { fixed: fixed, toBacklog: toBacklog };
    },

    /**
     * 合并一次 Steam 愿望单抓取结果（「愿望单 -> 待游玩」那一步）。
     *
     * :param items  [{appid, priority, addedTs}, …]，服务端 /api/steam/wishlist
     *               原样给的数组。
     *
     * ## 新建的记录长什么样
     *
     * status = backlog（→ 出现在「待游玩」），source = 'wishlist'
     * （→ 「我的游戏单」里挂「未入库」角标）。appid 已经有，但 title/封面是空的
     * —— 愿望单接口不给名字，得靠 store 补全那条路填（见 local-src.js syncWishlist）。
     *
     * ## 已经在库里 / 已手动添加过的怎么办
     *
     * **只补愿望单身份，绝不碰状态。** 一款游戏可能既在库里又在愿望单里
     * （手动添加的、或者 Steam 还没把它移出去的），那种情况下它已经是
     * 「已拥有」，不能被愿望单这边拉回「待游玩」。
     *
     * ## 🔴 调用方必须保证的前提
     *
     * **只有「成功拿到一份非空列表」时才准调它。** 这个函数会做删除：
     * 本地有、这次返回里没有 → 判定「你从愿望单移除了它」。而
     *   · 接口失败（None）      → 前端根本不该走到这里
     *   · 空列表（未公开/为空）  → 前端也不该走到这里
     * 否则一次链路抖动、或者用户把愿望单隐私改成「仅好友」，
     * 就会把几百款记录一次清空。守卫写在 local-src.js syncWishlist 里。
     *
     * ## 删除的条件（很严格，故意的）
     *
     * 只有「愿望单来源 + 仍是待游玩 + 用户一次都没动过」才删 —— 改过状态、
     * 锁过、写过感想、收藏过、隐藏过的，一律只摘掉 wishlisted 标记、记录留着。
     * 用户既然花力气动过它，就从「愿望单的投影」变成了他自己的东西。
     *
     * 返回 { added, updated, removed, kept }
     */
    async mergeWishlist(items) {
      const list = Array.isArray(items) ? items : [];
      const existing = await this.all();
      const byAppid = new Map();
      existing.forEach(g => { if (g.appid != null) byAppid.set(String(g.appid), g); });

      const toSave = [];
      const toRemove = [];
      const seen = new Set();
      let added = 0, updated = 0, removed = 0, kept = 0;

      list.forEach(it => {
        const appid = it && it.appid;
        if (!appid) return;
        const key = String(appid);
        if (seen.has(key)) return;      // 接口理论上不会给重复，防御一下
        seen.add(key);

        const pri = it.priority || 0;
        const addedTs = it.addedTs || 0;
        const old = byAppid.get(key);

        if (old) {
          if (old.wishlisted && old.wishPriority === pri && old.wishAddedTs === addedTs) {
            return;                     // 没有任何变化，别白写一次
          }
          old.wishlisted = true;
          old.wishPriority = pri;
          old.wishAddedTs = addedTs;
          old.updatedAt = Date.now();
          toSave.push(old);
          updated++;
          return;
        }

        toSave.push(makeGame({
          appid: Number(appid),
          title: '',                    // 空着 —— 名字由商店补全那条路填，绝不编 "App 123"
          status: STATUS.BACKLOG,
          source: 'wishlist',
          wishlisted: true,
          wishPriority: pri,
          wishAddedTs: addedTs
        }));
        added++;
      });

      // ===== 已经不在愿望单里的 =====
      existing.forEach(g => {
        if (g.source !== 'wishlist') return;    // 不是愿望单来源，与它无关
        if (g.appid == null) return;
        if (seen.has(String(g.appid))) return;  // 还在愿望单里
        if (!g.wishlisted) return;              // 上轮已经处理过，别重复计数

        const touched = g.statusManualAt || g.statusLocked || g.myNote ||
                        g.favorite || g.hidden || g.status !== STATUS.BACKLOG;
        if (touched) {
          g.wishlisted = false;                 // 摘掉身份，记录留着
          g.updatedAt = Date.now();
          toSave.push(g);
          kept++;
          return;
        }
        toRemove.push(g.id);
        removed++;
      });

      if (toSave.length) await this.saveMany(toSave);
      for (const id of toRemove) await this.remove(id);
      return { added, updated, removed, kept };
    }
  };

  global.DataStore = DataStore;
})(window);
