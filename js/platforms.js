/*
 * MyGameVaultList — 平台注册表
 *
 * 为什么单独一个文件：这个应用要能同时管多个游戏平台（Steam / EPIC / 以后可能还有别的）。
 *
 * 🔴 平台之间的差异**只允许写在下面这份注册表里** —— 不许散成 store.js / ui.js 里的
 *    `if (平台 === 'xxx')`。散着写的代价不是"多打几行字"，而是**每个 if 都要多问一次**，
 *    而其中大半只在某一个平台上成立；等接第三个平台时，没人能保证没有漏网的那一处。
 *    界面要按这里声明的**能力**（capabilities）决定"显示什么"，
 *    而不是"先把字段铺出来、等数据不来再把它解释成空"。
 *
 * ⚠️ 零依赖、零副作用：只登记数据，不碰 DOM、不碰 localStorage、不发网络请求。
 *    它在 store.js / ui.js **之前**加载（见 index.html 的 <script> 顺序），
 *    所以那两个文件随时可以读它。
 *
 * ⚠️ 别和「运行形态」搞混：这里说的是**数据来自哪个游戏平台**。
 *    "跑在双击 index.html 的本地版里，还是跑在桌面版里"是另一回事（`state.desktop`，
 *    由 /api/local/status 回答）。两件事**正交** —— 两种形态下都会看到同一排平台标签页。
 *
 * ⚠️ 与「source 角标」的区别：`source`（已拥有 / 未入库 / 家人拥有 / 手动）说的是
 *    **这条记录在它自己那个平台里的身份**，是平台内部的语义；`platform` 说的是
 *    **它在哪个平台里**。两者不能互相顶替：Steam 的「家人拥有」和 EPIC 的某一种来源
 *    是不同轴的标签，混用会写出"分不清是谁的"角标。
 */
(function (global) {
  'use strict';

  /**
   * 能力字典：能力名 -> 中文说明。
   * 🔴 说明文字**只在这里写一份**：界面上"这个平台能给什么 / 缺什么"都从这里取，
   *    别在 ui.js 里另抄一遍 —— 两处措辞迟早会对不上，而用户看到的正是那两处。
   */
  const CAPS = {
    installed:    '已安装清单',
    library:      '完整游戏库',
    playtime:     '游玩时长',
    lastPlayed:   '最后游玩时间',
    achievements: '成就进度',
    wishlist:     '愿望单',
    family:       '家庭共享',
    // ⚠️ 这三项**故意拆开**（原来是合成一个 `meta` 的）：EPIC 从本机文件里能拿到
    //    开发商与发售日期（`catcache.bin` 的 `developer` / `releaseInfo[0].dateAdded`），
    //    但**拿不到游戏类型**。合成一项的话只有两个选择，两个都是错的：
    //      · 声明"有 meta" → 界面上会出现永远空着的类型；
    //      · 声明"没 meta" → 发售年排序对 EPIC 被无理由地藏掉。
    //    拆开之后每个字段各说各的，能力表才是"事实"而不是"大致的印象"。
    developer:    '开发商',
    release:      '发售年',
    genres:       '类型',
    review:       '玩家评价'
  };

  /**
   * 兜底平台：**记录里没写 platform 时算它**。
   * 🔴 这个默认值不是随手挑的 —— `platform` 字段是后加的，历史数据、以及线上版下线前
   *    导出的那批备份里**都没有它**。按"缺失即 Steam"解释，老数据一条都不用迁移、
   *    旧备份也能原样导入。
   */
  const DEFAULT_ID = 'steam';

  const _list = [];
  const _byId = {};

  /**
   * 登记一个平台。**这是唯一的扩展入口** —— 接新平台 = 在这里加一条声明 + 一个数据源，
   * 界面（标签页、统计、排序、筛选）一行都不用改。
   *
   * @param {object} def
   * @param {string} def.id            稳定标识，**会写进每条记录的 platform 字段**。
   *                                   ⚠️ 改它 = 把所有旧记录留在旧 id 上（等于库空了），别改。
   * @param {string} def.label         完整名（提示语、占位区里用）
   * @param {string} def.short         标签页上的字
   * @param {string} def.mark          角标字形（纯文本，不引外链图片）
   * @param {string} def.color         品牌色 —— 标签页选中那条线和字形用它
   * @param {boolean} def.available    现在能不能用。false = 标签页点得开，但里面是"尚未接入"
   * @param {string} [def.unavailableWhy] 不可用时的原因（一句话，给用户看）
   * @param {string[]} def.capabilities 能给的能力（CAPS 里的键）
   * @param {string[]} [def.missing]    明确知道**拿不到**的能力 —— 列表要诚实，
   *                                    写下来是为了让界面能直说"这个平台没有 X"，
   *                                    而不是让用户对着一个永远空的字段猜
   * @param {boolean} [def.manualAdd]   这个平台**能不能手动添加**。缺省 = 不能。
   *                                    🔴 缺省不能是刻意的：手动添加那个表单是
   *                                    **某一个平台的语义**（问的是它的商品号、搜的是
   *                                    它的商店、封面按它的 URL 拼）。在一个不适用它的
   *                                    平台上放开，建出来的记录会落到别的平台去。
   * @param {Function} [def.storeUrl]   一条记录 → 它在**自己平台**上的商店页地址。
   *                                    没有这个函数 = 这个平台不提供外链，界面就不画链接。
   *                                    🔴 存在的意义：详情页那条"去商店看看"曾经是
   *                                    写死的某个平台的 URL —— 拿别的平台的记录去点它，
   *                                    会打开一个**不存在的页面**（或错误的那一款）。
   */
  function register(def) {
    if (!def || !def.id) throw new Error('platform needs an id');
    if (_byId[def.id]) throw new Error('platform already registered: ' + def.id);
    const p = Object.assign({
      label: def.id,
      short: def.id,
      mark: '',
      color: '',
      available: false,
      unavailableWhy: '',
      capabilities: [],
      missing: [],
      // 缺省 = **不能**手动添加（理由见 register 的 @param）
      manualAdd: false,
      // 缺省 = 不提供商店外链
      storeUrl: null
    }, def);
    _byId[p.id] = p;
    _list.push(p);
    return p;
  }

  /** 全部平台，**按登记顺序**（标签页就按这个顺序排） */
  function all() { return _list.slice(); }

  /** 取一个平台的声明；没登记过返回 null */
  function get(id) { return _byId[id] || null; }

  /** 完整名（没登记过就原样回 id —— 至少能让用户看出是哪个平台） */
  function labelOf(id) {
    const p = get(id);
    return p ? p.label : String(id == null ? '' : id);
  }

  /** 能力名的中文说明 */
  function capLabel(cap) { return CAPS[cap] || String(cap == null ? '' : cap); }

  /**
   * 这个平台现在具不具备某项能力 —— **界面所有"要不要显示"的判断都走它**。
   *
   * ⚠️ `!p.available` 一律视为"什么都没有"：还没接进来 = 一个字段都还没填过，
   *    这时按声明里的 capabilities 显示按钮，只会得到一堆点了没反应的控件。
   *    （声明里的 capabilities 在这里的角色是**计划**：占位区会说"接入后能拿到…"。）
   * ⚠️ `cap` 传 null/undefined = 这项不依赖任何平台数据（比如"按名称排序"）→ 恒真。
   */
  function supports(id, cap) {
    if (!cap) return true;
    const p = get(id);
    return !!(p && p.available && (p.capabilities || []).indexOf(cap) >= 0);
  }

  /** 缺什么（声明里写下的那份），给占位区用 */
  function missingOf(id) {
    const p = get(id);
    return p ? (p.missing || []).slice() : [];
  }

  /**
   * 一条记录属于哪个平台 —— **唯一判据**。
   *
   * 🔴 所有按平台分组的代码都必须走它，不许自己写 `g.platform || 'steam'`：
   *    同一个判断散成两处，其中一处漏了，症状是"切到 Steam 标签页，数字里却混着
   *    别的平台"——两个数各自看着都挺合理，极难发现（和"总库角标数 ≠ 格子里张数"
   *    是同一类问题）。
   *
   * ⚠️ 非空字符串**原样返回**。所以**新增平台必须先 register() 再往记录里写它的 id**：
   *    没登记过的 id 在所有标签页里都筛不出来（记录会凭空看不见），
   *    这是刻意的 —— 宁可查得出来"有个平台忘了登记"，也不要把它算进 Steam。
   */
  function of(game) {
    const p = game && game.platform;
    if (typeof p === 'string' && p) return p;
    return DEFAULT_ID;
  }

  /**
   * 一条记录在**它自己那个平台**上的商店页地址；这个平台不提供 → 空串。
   *
   * ⚠️ 一律走它，**别在界面里拼**某个平台的 URL：拼出来的东西对别的平台是错的，
   *    而错的方式很隐蔽 —— 点开是一个真实存在、但**不是你这款**的页面。
   * ⚠️ 声明里的函数写崩了不该让整个详情页打不开 → 这里兜住，返回空串。
   */
  function storeUrlOf(id, game) {
    const p = get(id);
    if (!p || typeof p.storeUrl !== 'function') return '';
    try {
      const u = p.storeUrl(game || {});
      return typeof u === 'string' ? u : '';
    } catch (e) {
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // 数据源（`platforms.js` 自己**不碰网络**，只留一个挂载位）
  // ---------------------------------------------------------------------------
  // 🔴 为什么在这里而不是在声明里写：这个文件是**零依赖、零副作用**的（它排在
  //    store.js / ui.js 之前，只登记数据）。数据源要发请求、要写存储，
  //    放进来的话它就再也不是"一张纯表"了。
  //    所以数据源由**它自己那个文件**（`js/epic-src.js`）在加载时挂上来。
  //
  // 这么做的收益是界面那侧彻底不需要知道平台名：`ui.js` 只问
  // 「当前平台有没有数据源」，有就调它的 `probe` / `sync`，没有就说"接不进来"。
  // 加第三个平台时，`ui.js` 依然一行都不用改。
  const _sources = {};

  /**
   * 挂一个数据源。
   * @param {string} id 平台 id（必须先 register 过）
   * @param {object} src
   * @param {Function} [src.probe] 只读探一下（不改任何数据）→ {ok, reason, text, ...}
   * @param {Function} src.sync    真读进来（会写库）→ {ok, reason, text, total, added, ...}
   * @param {string} [src.loadingText] 读的过程中占位区显示的那句话
   */
  function registerSource(id, src) {
    if (!get(id)) throw new Error('registerSource: 平台还没登记：' + id);
    if (!src || typeof src.sync !== 'function') {
      throw new Error('registerSource: 数据源必须有一个 sync()');
    }
    _sources[id] = src;
    return src;
  }

  /** 这个平台的数据源；没挂（= 还没接入 / 只读展示）→ null */
  function sourceOf(id) { return _sources[id] || null; }

  // ============================================================
  // 内置平台
  // ============================================================

  register({
    id: 'steam',
    label: 'Steam',
    short: 'Steam',
    mark: '◈',
    color: '#66c0f4',
    available: true,
    // Steam 这条路**已经全部打通**（本机文件 + Web API + 家庭库），所以没有 missing ——
    // 这一项为空本身就是一句结论："Steam 能给的东西它都给了"。
    capabilities: ['installed', 'library', 'playtime', 'lastPlayed',
                   'achievements', 'wishlist', 'family',
                   'developer', 'release', 'genres', 'review'],
    missing: [],
    // 手动添加那个表单就是 Steam 语义的（问 AppID、搜 Steam 商店）
    manualAdd: true,
    storeUrl: g => 'https://store.steampowered.com/app/' + g.appid + '/'
  });

  // ---------------------------------------------------------------------------
  // EPIC（2026-09-29 阶段 2 落地：**只读本机文件，免登录**）
  //
  // 数据源两处，都在 `%PROGRAMDATA%\\Epic\\` 下：
  //   · `...\\Data\\Catalog\\catcache.bin` —— **已拥有全库（含没装的）**，base64 套明文 JSON
  //   · `...\\Data\\Manifests\\*.item`     —— 已安装清单，一个安装一个 JSON
  // 实测判据与字段见 `server/epic_local.py` 的文件头（出处是别人对着真机的字段级实测）。
  //
  // 🔴 `missing` 里那几项**不是"还没做"，是"EPIC 没有"**：
  //    · `lastPlayed` —— EPIC 整个数据模型里就没有"最后游玩时间"（schema 级确认）。
  //      而应用里"近 90 天玩过 = 正在游玩 / 否则已暂停"那条自动归类**完全**依赖它
  //      （`store.js` 的 suggestStatus）→ **EPIC 的记录永远不会被自动搬进那两个区块**，
  //      一律停在「我的游戏单」。写在这里是为了让界面能直说，而不是让用户
  //      对着一个永远算不出来的状态猜原因。
  //    · `playtime` 要登录后走**非官方**接口才拿得到 → 本阶段不做。
  //    · 成就 / 愿望单 / 家庭共享 / 类型：本机没有任何来源。
  // ---------------------------------------------------------------------------
  register({
    id: 'epic',
    label: 'EPIC',
    short: 'EPIC',
    mark: '⬢',
    color: '#a3a9b8',
    available: true,
    // 只声明**真的读得到**的：整库（含没装的）、已安装清单、开发商、发售年
    capabilities: ['installed', 'library', 'developer', 'release'],
    missing: ['playtime', 'lastPlayed', 'achievements', 'wishlist', 'family',
              'genres', 'review']
  });

  global.GVPlatforms = {
    CAPS,
    DEFAULT_ID,
    register,
    all,
    get,
    labelOf,
    capLabel,
    supports,
    missingOf,
    of,
    storeUrlOf,
    registerSource,
    sourceOf
  };
})(typeof window !== 'undefined' ? window : this);
