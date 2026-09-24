/*
 * GameVault — Steam 游戏历程管理器
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
  // 默认只认 Steam 自带的那两个，其余由用户在「设置」里自己填。
  // 同步脚本会把收藏夹名原样写进 games[].collections，这里只负责"哪个名字算什么状态"。
  const PREFS_KEY = 'gv_prefs_v1';

  const DEFAULT_PREFS = {
    completedCollections: ['已完结'],   // -> 归入「已通关」
    hiddenCollections:    ['已隐藏']    // -> 视为用户主动隐藏（优先级最高）
  };

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
      hiddenCollections:    DEFAULT_PREFS.hiddenCollections.slice(),
      // 用户有没有亲手改过这两项 —— 决定要不要做老数据迁移
      completedTouched: false,
      hiddenTouched:    false
    };
    try {
      const raw = global.localStorage.getItem(PREFS_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === 'object') {
        const c = normalizeNames(saved.completedCollections);
        const h = normalizeNames(saved.hiddenCollections);
        // 空列表按"没设过"处理 —— 存成空会让「已通关」永远没人进
        if (c.length) prefs.completedCollections = c;
        if (h.length) prefs.hiddenCollections = h;
        prefs.completedTouched = !!saved.completedTouched;
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
      hiddenCollections:    p.hiddenCollections.slice(),
      completedTouched:     p.completedTouched,
      hiddenTouched:        p.hiddenTouched
    };
  }

  /**
   * 改偏好。两项都接受「数组」或「逗号分隔的字符串」。
   * 传空 = 没填 = 保持原值（不存空列表，否则等于把自动归类关掉）。
   */
  function setPrefs(patch) {
    const p = readPrefs();
    if (patch && patch.completedCollections !== undefined) {
      const v = normalizeNames(patch.completedCollections);
      p.completedCollections = v.length ? v : DEFAULT_PREFS.completedCollections.slice();
      p.completedTouched = true;
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
      hiddenCollections:    DEFAULT_PREFS.hiddenCollections.slice()
    };
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
      manualHidden: null,       // 手动设定过隐藏开关；非空则优先于自动判定
      dismissedCollection: false, // 用户主动把它从「已通关」挪走过，不再被收藏夹拉回
      hidden: false,            // 是否隐藏（工具/软件默认隐藏）
      steamReview: '',          // 玩家在 Steam 写的评价（抓不到就空）
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
   *   2. 放弃区（abandoned）      —— 同上，手动终态，本函数也**永远不返回**它
   *   3. 「归入已通关」的收藏夹 —— 只要在这分类里，就是已通关（归档，不看日期）
   *                                （具体是哪个分类名，看用户的设置）
   *   4. 全成就                   —— 同上，已通关是终态
   *   5. 启动日期（90 天阈值）    —— ≤90 天 = 正在游玩；>90 天 = 已暂停
   *   6. 从未启动                 —— 停在总库，不参与日期归类
   *
   * 注意 1：hidden（工具隐藏）不在这里处理，隐藏优先级最高，
   *         在 mergeSteam 里用 isToolGame / inHiddenCollection 单独判定。
   * 注意 2：手动优先的细节（手动晚于启动则保留手动结果）也在 mergeSteam 里处理。
   */
  function suggestStatus(game) {
    // 2. 用户指定的「通关」收藏夹 —— 优先级高于全成就判断
    if (inCompletedCollection(game)) return STATUS.COMPLETED;

    // 3. 全成就 —— 已通关是归档终态，不再看启动日期
    const ach = game.achievements;
    const allDone = !!(ach && ach.total > 0 && ach.earned >= ach.total);
    if (allDone) return STATUS.COMPLETED;

    // 4. 按启动日期分流：近期玩过 -> 正在游玩，久未启动 -> 已暂停
    const days = daysSincePlayed(game);
    if (days >= 0) {
      if (days <= RECENT_DAYS) return STATUS.PLAYING;
      return STATUS.PAUSED;
    }

    // 5. 从未启动（也没有 recentMinutes）：停在总库，等用户自己决定
    if (game.recentMinutes > 0) return STATUS.PLAYING;

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
    inHiddenCollection,
    adoptLegacyCollection,

    // 收藏夹 -> 状态的映射由用户自己定（见文件顶部 PREFS_KEY 那段）
    getPrefs,
    setPrefs,
    defaultPrefs,
    collectionsInData,
    tsToDate,
    yearOf,
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
      const existing = await this.all();
      const byAppid = new Map();
      existing.forEach(g => { if (g.appid != null) byAppid.set(String(g.appid), g); });

      // 老用户升级上来的第一趟：数据里（不管是库里已有的还是这次喂进来的）
      // 带着旧版写死的分类名就一并认下来，否则「已通关」会整体回退。
      // 只认一次，且用户改过设置就不动。
      adoptLegacyCollection(existing.concat(incoming));

      const toSave = [];
      let added = 0, updated = 0, recollected = 0, locked = 0, abandoned = 0;

      incoming.forEach(src => {
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

          // ===== 状态归类 =====
          // 优先级（高 -> 低）：
          //   1. 锁定（statusLocked）        -> 一律不动
          //   2. 放弃区（abandoned）         -> 手动终态，一律不动
          //   3. 已通关（收藏夹 / 全成就）   -> 归档终态，不受日期影响
          //   4. 手动改状态晚于上次启动      -> 尊重手动结果
          //   5. 启动日期（90 天阈值）       -> 正在游玩 / 已暂停
          //   6. 从未启动                    -> 停在总库
          if (old.statusLocked) {
            // 锁定的游戏：状态一动不动，连「已通关」也不重算
            locked++;
          } else if (old.status === STATUS.ABANDONED) {
            // 「放弃」是手动终态，和锁定同级：
            // 「不打算再玩了」只有用户能判断，所以同步时一律不动 ——
            // 包括不被「通关」收藏夹 / 全成就拉回「已通关」，
            // 也不因为"后来又启动了一次"被日期规则挪去「正在游玩」。
            // 想让它回到别的状态，手动改一下即可（改完就不再是 abandoned）。
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

            if (manualWins) {
              // 手动优先：状态保持不动
              old.autoStatus = false;
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
          delete g.suggestedStatus;   // 内部字段，不入库
          if (!Array.isArray(g.collections)) g.collections = [];
          // 标记这条状态是不是自动规则产生的（供 UI 打「自动」角标）
          g.autoStatus = (g.status === STATUS.PLAYING || g.status === STATUS.PAUSED);
          g.hidden = inHiddenCollection(g) || isToolGame(g);
          toSave.push(g);
          added++;
        }
      });

      await this.saveMany(toSave);
      return { added, updated, recollected, locked, abandoned };
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
     * 合并一次 Steam 愿望单抓取结果（「愿望单 -> 待游玩」那一步）。
     *
     * :param items  [{appid, priority, addedTs}, …]，服务端 /api/steam/wishlist
     *               原样给的数组。
     *
     * ## 新建的记录长什么样
     *
     * status = backlog（→ 出现在「待游玩」），source = 'wishlist'
     * （→ 「我的游戏单」里挂「未入库」角标）。appid 已经有，但 title/封面是空的
     * —— 愿望单接口不给名字，得靠 store 补全那条路填（见 cloud.js syncWishlist）。
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
     * 就会把几百款记录一次清空。守卫写在 cloud.js syncWishlist 里。
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
