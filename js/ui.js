/*
 * MyGameVaultList — 界面逻辑
 * 依赖 store.js 暴露的 DataStore
 */

(function () {
  'use strict';

  const DS = window.DataStore;
  const S = DS.STATUS;
  const META = DS.STATUS_META;
  // 平台注册表（js/platforms.js）。**平台之间的差异全在它的声明里** ——
  // 这个文件里不该出现平台名，见那个文件顶部的说明。
  const PF = window.GVPlatforms;

  // ===== 应用状态 =====
  const state = {
    games: [],

    // 🔴 当前平台（'steam' / 'epic'…）—— 它是**比 view 更高一层**的轴：
    //    先选平台，再看那个平台的区块。统计、侧栏角标、格子、页脚**全部按它过滤**
    //    （唯一入口是下面的 platformGames()）。
    // ⚠️ 刻意**不持久化**（和 state.view 一个口径）：它属于"导航"。
    //    启动一律落在默认平台 —— 存下来的话，用户上次停在 EPIC，这次一打开就是
    //    一个空平台，还得自己找回来。
    // ⚠️ 与 state.desktop **正交**：那个说的是"跑在哪种形态里"，这个说的是
    //    "数据来自哪个平台"。两种形态下都看得到同一排平台标签页。
    platform: PF.DEFAULT_ID,

    view: S.PLAYING,        // 当前视图（默认正在游玩）
    sort: 'lastPlayed',
    search: '',
    hideTools: false,       // 总库：是否隐藏工具/软件（默认显示，排底部独立一段）
    hideCompleted: false,   // 总库：是否隐藏已通关的游戏
    hideAbandoned: false,   // 总库：是否隐藏放弃区的游戏
    // 总库：是否隐藏「家人拥有」的款（source='family'，家庭共享里、**你并不拥有**的）。
    // 🔴 **默认 true** —— 家庭并集实测一次能进来几百款，
    //    默认摊开会让"我的库"当场变成一团糊。它是"想看才看"的一份清单，
    //    在筛选里明示个数（`filterToggles` 那个开关），同步完也会在状态行提一句在哪儿开。
    hideFamily: true,
    filterOpen: false,      // 总库筛选选项是否展开（纯界面状态，不持久化）
    groupPerfect: false,    // 「已通关」区：是否按全成就/非全成就分两段
    selectMode: false,      // 批量选择模式（暂停区里清理"不想再玩了"用）
    selected: {},           // 已选中的游戏 id（当 Set 用：{ id: true }）
    noteTargetId: null,
    // 当前详情抽屉里是哪一款（没开就是 null）。**唯一用途**：后台补资料跑完时
    // 知道该重绘哪一张 —— 不然用户正看着这款的详情，资料补上了却停在旧内容上，
    // 他会以为没补到。openDrawer 是幂等的（重调=重绘），所以直接重调它即可。
    drawerId: null,
    syncPayload: null,
    desktop: false,         // 是否跑在桌面版里（boot 里探测出来后置真）

    // 每个平台的「本机数据源读得怎么样」：平台 id → { state, text }。
    //   'loading' 正在读 / 'fail' 读不到（text 是原因）/ 'ready' 读到了、等用户点同步 /
    //   'ok' 已经同步过了。**没有这个键 = 还没探过。**
    // 🔴 只活在内存里，**刻意不持久化** —— 它是一次探测的结果、不是偏好。
    //    存下来的话，"上次没装 EPIC"会被记一辈子，装好之后界面还在说没有。
    platNote: {}
    // ⚠️ 这里原来还有个 `cloud`（是否云端模式），随线上版 2026-09-28 下线一起删了 ——
    //    连带 forceLocal / cloudMode / `#btnMenu` 的隐藏 / `window.__gvRefresh`
    //    全都只服务于那一种模式。
    //    留下的教训：每引入一种运行模式，每个 if 都要多问一次，而它只在一种部署里成立。
    //    现在只承认两种形态：「双击 index.html 的本地版」和「桌面版」，别再添第三种。
  };

  /**
   * 桌面版最近一次 `/api/local/status` 的结果。
   * 打开设置面板时读它填输入框；用户在面板里改了目录、保存成功后再刷新它。
   */
  let desktopStatus = null;

  // ===== 手动添加 · 商店联想的临时状态 =====
  // 全部不持久化：属于"这一次弹窗里正在发生的事"，关掉弹窗就该没了。
  let sgTimer = null;      // 防抖定时器
  let sgSeq = 0;           // 请求序号 —— 只认最新那一次响应（理由见 doSuggest）
  let sgItems = [];        // 当前候选（渲染用）
  let sgIndex = -1;        // 键盘高亮的下标（-1 = 没高亮）
  let sgTerm = '';         // 当前候选是对哪个词搜出来的

  /** 退出批量选择模式，并清空选中 */
  function exitSelectMode() {
    state.selectMode = false;
    state.selected = {};
  }

  // ===== DOM =====
  const $ = (sel) => document.querySelector(sel);
  const el = {
    brandSub:    $('#brandSub'),
    statsBar:    $('#statsBar'),
    platTabs:    $('#platTabs'),
    viewNav:     $('#viewNav'),
    legend:      $('#legend'),
    viewTitle:   $('#viewTitle'),
    viewCount:   $('#viewCount'),
    filterBtn:   $('#filterBtn'),
    filterBadge: $('#filterBadge'),
    filterPanel: $('#filterPanel'),
    sortSeg:     $('#sortSeg'),
    groupPerfectBtn: $('#groupPerfectBtn'),
    selectModeBtn:   $('#selectModeBtn'),
    selbar:      $('#selbar'),
    selbarCount: $('#selbarCount'),
    selAllBtn:   $('#selAllBtn'),
    selDropBtn:  $('#selDropBtn'),
    selExitBtn:  $('#selExitBtn'),
    grid:        $('#grid'),
    emptyState:  $('#emptyState'),
    emptyTitle:  $('#emptyTitle'),
    emptyHint:   $('#emptyHint'),
    searchInput: $('#searchInput'),
    footInfo:    $('#footInfo'),

    drawer:      $('#drawer'),
    drawerMask:  $('#drawerMask'),
    drawerBody:  $('#drawerBody'),
    drawerClose: $('#drawerClose'),

    modalMask:   $('#modalMask'),
    modalClose:  $('#modalClose'),
    modalCancel: $('#modalCancel'),
    modalSave:   $('#modalSave'),
    mTitle:      $('#mTitle'),
    mSuggest:    $('#mSuggest'),
    mAppid:      $('#mAppid'),
    mStatus:     $('#mStatus'),
    mNote:       $('#mNote'),

    noteMask:    $('#noteMask'),
    noteClose:   $('#noteClose'),
    noteCancel:  $('#noteCancel'),
    noteSave:    $('#noteSave'),
    noteText:    $('#noteText'),
    noteGameName:$('#noteGameName'),

    syncMask:    $('#syncMask'),
    syncClose:   $('#syncClose'),
    syncCancel:  $('#syncCancel'),
    syncApply:   $('#syncApply'),
    syncFile:    $('#syncFile'),
    syncFileSec: $('#syncFileSec'),
    syncFileHint:$('#syncFileHint'),
    syncFileEm:  $('#syncFileEm'),
    syncStatus:  $('#syncStatus'),
    syncDiff:    $('#syncDiff'),
    syncLocalSec:$('#syncLocalSec'),
    syncLocalInfo:$('#syncLocalInfo'),
    syncSourceNote:$('#syncSourceNote'),
    syncFamilyNote:$('#syncFamilyNote'),
    syncLocalBtn:$('#syncLocalBtn'),
    syncLocalSetup:$('#syncLocalSetup'),

    setMask:     $('#setMask'),
    setClose:    $('#setClose'),
    setSave:     $('#setSave'),
    setReset:    $('#setReset'),
    setCompleted:$('#setCompleted'),
    setHidden:   $('#setHidden'),
    setCollList: $('#setCollList'),
    setColls:    $('#setColls'),

    // 设置里的「Steam 账号（联网同步）」（仅桌面版可见）
    setAcctSec:    $('#setAcctSec'),
    setAcctId:     $('#setAcctId'),
    setAcctKey:    $('#setAcctKey'),
    setAcctState:  $('#setAcctState'),
    setAcctDetect: $('#setAcctDetect'),
    setAcctVerify: $('#setAcctVerify'),
    setAcctClear:  $('#setAcctClear'),

    // 设置里的「Steam 安装目录」一节（仅桌面版可见）
    setSteamSec:   $('#setSteamSec'),
    setSteamDir:   $('#setSteamDir'),
    setSteamState: $('#setSteamState'),
    setSteamFound: $('#setSteamFound'),
    setSteamScan:  $('#setSteamScan'),
    setSteamDetect:$('#setSteamDetect'),

    btnAdd:      $('#btnAdd'),
    btnSync:     $('#btnSync'),
    btnSettings: $('#btnSettings'),

    // 设置里的「数据备份」（仅本地/桌面版可见）
    setBackupSec:   $('#setBackupSec'),
    setBackupExport:$('#setBackupExport'),
    setBackupImport:$('#setBackupImport'),
    setBackupFile:  $('#setBackupFile'),
    setBackupState: $('#setBackupState'),

    // 设置里的「危险操作」+ 它弹出的二级确认窗（#wipeMask）
    setDangerSec: $('#setDangerSec'),
    setWipe:      $('#setWipe'),
    wipeMask:     $('#wipeMask'),
    wipeList:     $('#wipeList'),
    wipeKeep:     $('#wipeKeep'),
    wipeAck:      $('#wipeAck'),
    wipeGo:       $('#wipeGo'),
    wipeCancel:   $('#wipeCancel'),
    wipeClose:    $('#wipeClose')
  };

  // ===== 工具 =====
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtHours(min) {
    const h = DS.minutesToHours(min);
    if (!h) return null;
    if (h < 1) return '<1';
    return h >= 100 ? String(Math.round(h)) : String(h);
  }

  /**
   * 装机体积（字节）→ 人能读的一行。没有值就返回 null（界面按「—」渲染）。
   *
   * ⚠️ 用 1024 进制、单位写 GB/MB —— 和 Steam / EPIC 自己的写法一致。
   *    写成 GiB 反而会让人对不上号（用户会拿它去和自己的盘比对）。
   */
  function fmtSize(bytes) {
    const b = Number(bytes) || 0;
    if (b <= 0) return null;
    if (b >= 1024 * 1024 * 1024) return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return Math.round(b / 1024) + ' KB';
  }

  function fmtDate(ts) {
    const d = DS.tsToDate(ts);
    if (!d) return null;
    const [y, m, day] = d.split('-');
    return y + '/' + m + '/' + day;
  }

  function relTime(ts) {
    if (!ts) return null;
    const diff = Date.now() / 1000 - ts;
    const day = 86400;
    if (diff < day) return '今天';
    if (diff < 2 * day) return '昨天';
    if (diff < 7 * day) return Math.floor(diff / day) + ' 天前';
    if (diff < 30 * day) return Math.floor(diff / (7 * day)) + ' 周前';
    if (diff < 365 * day) return Math.floor(diff / (30 * day)) + ' 个月前';
    return Math.floor(diff / (365 * day)) + ' 年前';
  }

  function statusColor(st) {
    return (META[st] && META[st].color) || 'var(--st-library)';
  }

  // ===== 排序 =====
  const SORTS = ['lastPlayed', 'playtime', 'achievement', 'title', 'release'];

  /**
   * 每个排序各自依赖哪一项**平台能力**（能力名见 js/platforms.js 的 CAPS）。
   *
   * 🔴 缺能力 = 这一项对这个平台没意义，按钮直接不显示。
   *    例：EPIC 那个接口给不出可靠的"最后游玩时间"（注册表里写在 missing 里），
   *    而「最近游玩」排序全靠它 —— 留着这个按钮，用户点下去只会得到一个
   *    看着有顺序、其实全是 0 的列表，比没有这个按钮更坏。
   * `null` = 不依赖任何平台数据（按名称排，谁都能做）。
   */
  const SORT_CAP = {
    lastPlayed:  'lastPlayed',
    playtime:    'playtime',
    achievement: 'achievements',
    title:       null,
    release:     'release'
  };

  /**
   * 实际生效的排序。与 `state.sort` 分开是**故意的**：
   * 切到 EPIC 时「最近游玩」不成立，但**不许**把 state.sort 改掉 ——
   * 那等于用户只是去别的平台看了一眼，回来就发现自己的排序被换了。
   * 所以这里只降级**这一次渲染用哪个**，偏好本身留着（切回去自动恢复）。
   */
  function effectiveSort() {
    if (PF.supports(state.platform, SORT_CAP[state.sort])) return state.sort;
    const ok = SORTS.find(s => PF.supports(state.platform, SORT_CAP[s]));
    return ok || 'title';
  }

  /** 成就完成率 0~1；无成就数据返回 -1（排最后） */
  function achRatio(g) {
    const a = g.achievements;
    if (!a || !a.total || a.earned == null) return -1;
    return a.earned / a.total;
  }

  function sortGames(list) {
    const arr = list.slice();
    switch (effectiveSort()) {
      case 'playtime':
        arr.sort((a, b) => (b.totalMinutes || 0) - (a.totalMinutes || 0));
        break;
      case 'title':
        arr.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'));
        break;
      case 'release':
        arr.sort((a, b) => (b.releaseYear || 0) - (a.releaseYear || 0));
        break;
      case 'achievement':
        // 全成就最前，其次按完成率降序，无成就数据的垫底
        arr.sort((a, b) => {
          const pa = DS.isPerfect(a) ? 1 : 0, pb = DS.isPerfect(b) ? 1 : 0;
          if (pa !== pb) return pb - pa;
          const ra = achRatio(a), rb = achRatio(b);
          if (ra !== rb) return rb - ra;
          // 完成率相同时，玩得久的排前面
          return (b.totalMinutes || 0) - (a.totalMinutes || 0);
        });
        break;
      case 'lastPlayed':
      default:
        arr.sort((a, b) => (b.lastPlayedTs || 0) - (a.lastPlayedTs || 0));
        break;
    }
    return arr;
  }

  /** 分组标题 HTML（横跨整行的分隔条） */
  function groupHeadHtml(icon, label, count, cls) {
    return '<div class="grouphead ' + (cls || '') + '">' +
             '<span class="gh-icon">' + icon + '</span>' +
             '<span class="gh-label">' + esc(label) + '</span>' +
             '<span class="gh-count">' + count + ' 款</span>' +
           '</div>';
  }

  /**
   * 生成网格 HTML。支持两种分组，可同时生效：
   *  - 总表（我的游戏单）：游戏在前，工具/软件排底部独立一段
   *  - 已通关区：按 全成就 / 未全成就 分两段
   */
  function gridHtml(list, cardOpts) {
    // --- 总库：游戏 / 工具软件 分段 ---
    if (state.view === S.LIBRARY) {
      // 走到这里的 list 已经过 gamesInView() 过滤：
      //   - 默认：游戏（不含被隐藏的）+ 工具/软件
      //   - 开了「隐藏非游戏」：只剩游戏
      const tools = list.filter(g => DS.isToolGame(g));
      const games = list.filter(g => !DS.isToolGame(g));

      let html = '';
      if (games.length) {
        // 有工具段时才给游戏段加标题，否则纯平铺更干净
        if (tools.length) html += groupHeadHtml('🎮', '游戏', games.length, 'gh-games');
        html += games.map(g => cardHtml(g, cardOpts)).join('');
      }
      if (tools.length) {
        html += groupHeadHtml('🛠️', '工具 / 软件', tools.length, 'gh-tools');
        html += tools.map(g => cardHtml(g, cardOpts)).join('');
      }
      return html;
    }

    // --- 已通关区：全成就 / 未全成就 分段 ---
    if (state.groupPerfect && state.view === S.COMPLETED) {
      const perfect = list.filter(g => DS.isPerfect(g));
      const rest = list.filter(g => !DS.isPerfect(g));
      let html = '';
      if (perfect.length) {
        html += groupHeadHtml('🏆', '全成就', perfect.length, 'gh-perfect');
        html += perfect.map(g => cardHtml(g, cardOpts)).join('');
      }
      if (rest.length) {
        html += groupHeadHtml('◈', '未全成就', rest.length, 'gh-rest');
        html += rest.map(g => cardHtml(g, cardOpts)).join('');
      }
      return html;
    }

    return list.map(g => cardHtml(g, cardOpts)).join('');
  }

  function gamesInView() {
    let list;
    if (state.view === S.LIBRARY) {
      // 总库的可见性判据**只有一处**（visibleInLibrary），渲染与计数共用它。
      // 以前这里是几条散落的 filter，和 `countOf` 那份**长得像但不相等**
      // （hideTools=false 时这里排掉"被收进「已隐藏」收藏夹的游戏"，那边却没排）
      // → 导航角标比格子里的卡多出 9 张，而两个数看着都合理，极难发现。
      list = platformGames().filter(visibleInLibrary);
    } else {
      // 状态区块里，隐藏的游戏不出现
      list = platformGames().filter(g => g.status === state.view && !g.hidden);
    }
    if (state.search) {
      const q = state.search.toLowerCase();
      list = list.filter(g =>
        String(g.title).toLowerCase().includes(q) ||
        (g.developers || []).some(d => String(d).toLowerCase().includes(q))
      );
    }
    return sortGames(list);
  }

  /**
   * 当前平台下的全部记录 —— **平台维度的唯一入口**。
   *
   * 🔴 统计条、侧栏角标、格子里的卡片、页脚那一行，全部必须过它。
   *    漏了一处的症状和下面 `visibleInLibrary` 那条教训一模一样：切到 Steam 标签页，
   *    数字里却混着别的平台 —— 两个数各自看着都挺合理，极难发现。
   * ⚠️ 只有"按 id / appid 找某一条记录"（state.games.find）**不**走它：
   *    那是全局查找，按平台过滤会让从消息记录/详情跳过来的入口找不到目标。
   */
  function platformGames() {
    const p = state.platform;
    return state.games.filter(g => PF.of(g) === p);
  }

  /**
   * 总库视图里该不该排除「家人拥有」（`source='family'`）。
   *
   * 「家人拥有」是**别人的**游戏：默认不摊在总库上（实测一次并集进来几百款），
   * 要用筛选里的开关才显示。所以凡是跟"总库里有什么"有关的判断都得过这一道 ——
   * 包括渲染、导航角标、以及「非游戏」那个计数。
   */
  function familyFilteredOut(g) {
    return state.hideFamily && g.source === 'family';
  }

  /**
   * 「这款现在在总库视图里显示吗」—— **唯一的判据**。
   *
   * 🔴 `gamesInView()`（真正渲染什么）与 `countOf()`（导航角标写几）都走它。
   *    两处口径必须逐字一致：角标数 ≠ 格子里实际张数，就是一种"界面在骗人"，
   *    而且特别难发现 —— 两个数字各自看着都挺合理（实测差 9 张，谁都看不出来）。
   *    **以后新增任何总库开关，只改这一个函数。**
   */
  function visibleInLibrary(g) {
    // 「隐藏非游戏」：
    //   开 = 工具/软件 + 被收进「已隐藏」收藏夹的，全部不显示；
    //   关 = 工具/软件照常显示（排底部独立一段），但**用户主动隐藏的不显示**
    //        （它们要靠上面那个开关才出来）。
    if (state.hideTools) { if (g.hidden) return false; }
    else if (g.hidden && !DS.isToolGame(g)) return false;

    if (state.hideCompleted && g.status === S.COMPLETED) return false;
    if (state.hideAbandoned && g.status === S.ABANDONED) return false;
    if (familyFilteredOut(g)) return false;
    return true;
  }

  /** 计数：状态区块排除隐藏项；总库走 visibleInLibrary（与渲染同一个判据） */
  function countOf(st) {
    if (st === S.LIBRARY) return platformGames().filter(visibleInLibrary).length;
    // 状态区块（在玩 / 待玩 / 已通关…）**故意不过滤家庭款**：
    // 用户手动把一张家庭卡拖去「正在游玩」时，那一区的格子里有它，
    // 计数就得有它。家庭款进来时状态一律停在「我的游戏单」（见 store.mergeFamily），
    // 所以默认情况下这几区的数本来就不受影响。
    return platformGames().filter(g => g.status === st && !g.hidden).length;
  }

  /** 非游戏内容数量：真工具/软件 + 用户藏在「已隐藏」收藏夹里的游戏 */
  function hiddenCount() {
    // 家庭并集里有一批工具件（Steam Client、Dedicated Server、各类 Mod Tools），
    // 它们默认 hidden=true。总库视图看不到家庭款时，这个数也不该把它们算进去
    // —— 否则「显示非游戏 47」点下去只出来 30 张，同样是"数对不上"。
    return platformGames().filter(g => g.hidden && !familyFilteredOut(g)).length;
  }

  /** 总库里已通关的数量（供开关标注） */
  function completedCount() {
    return platformGames().filter(g => g.status === S.COMPLETED).length;
  }

  /** 总库里已放弃的数量（供开关标注） */
  function abandonedCount() {
    return platformGames().filter(g => g.status === S.ABANDONED).length;
  }

  /** 「家人拥有」的数量（家庭共享里、你账号并不拥有的那批）—— 供开关标注 */
  function familyCount() {
    return platformGames().filter(g => g.source === 'family').length;
  }

  // ===== 渲染：统计条 =====
  function renderStats() {
    // ⚠️ 这一整条统计**只算当前平台**（platformGames）——直读 state.games 的话，
    //    切到 EPIC 标签页会看到 Steam 的库容量，「已拥有」当场变成别人的数字。
    //
    // ⚠️ 平台下的记录现在混着**三**种东西：平台库里的（已拥有）、只在愿望单里的
    // （未入库）、以及家庭共享里的（家人拥有，`source='family'`）。
    // 所以「游戏库」这个数**不能**再直接用列表长度 ——
    // 那会把 300 款还没买的 + 几百款家人的一起算进库容量里。
    // 按 source 拆开才对得上卡片角标，也才对得上用户在平台里看到的情况。
    //
    // 🔴 「家人拥有」**必须排除在「已拥有」之外**：它是别人的游戏。
    //    混进去的话「已拥有」会凭空多出几百款，
    //    而这个数字是用户判断"我到底有多少游戏"的唯一依据。
    // ⚠️ 「总时长」不用特意排除：family 记录的 `totalMinutes` 恒为 0
    //    （家人的时长存在独立的 `familyMinutes` 里），见 store.js 的 mergeFamily。
    const mine = g => g.source !== 'wishlist' && g.source !== 'family';
    const owned = platformGames().filter(mine).length;
    const wished = platformGames().filter(g => g.source === 'wishlist').length;
    const played = platformGames().filter(g => (g.totalMinutes || 0) > 0).length;
    const totalMin = platformGames().reduce((s, g) => s + (g.totalMinutes || 0), 0);
    const perfect = platformGames().filter(g => DS.isPerfect(g)).length;
    const playing = countOf(S.PLAYING);
    const backlog = countOf(S.BACKLOG);
    // 「装了几款 / 一共多大」—— 只在平台**没有时长能力**时用来顶替时长那两格。
    // ⚠️ 和卡片上的安装状态、详情页的统计格是同一份数据，别再各算一遍。
    const installedN = platformGames().filter(g => g.installed).length;
    const installedBytes = platformGames().reduce((s, g) => s + (g.installSize || 0), 0);

    // 🔴 格子**按能力拼**，不是写死七格。
    //
    // 为什么必须这样：EPIC 拿不到「游玩时长 / 最后游玩时间 / 成就 / 愿望单」，
    // 而它**每一条记录都算已拥有**（那是它的权益目录）。写死七格的话，
    // EPIC 标签页上会长期挂着「总时长 0 小时 / 玩过 0 款 / 全成就 0 款」——
    // 用户读到的是"你玩了 0 小时"，而真相是"这个平台给不出这个数"。
    // 这和卡片上那个永远空的时长格是同一个错，只是换了位置。
    //
    // 规则：
    //   · 有 `playtime`  → 时长那两格（原样，Steam 走这条，**格子与顺序一位不差**）
    //   · 没有 `playtime` 但有 `installed` → 换成「已安装 / 占用空间」（换成读得出来的事实）
    //   · 没有 `wishlist` / `achievements` → 那两格**不出现**（它们对这个平台恒为 0）
    // ⚠️ 「正在玩 / 待玩」不按能力裁：它们看的是**状态**，用户手动把一款挪进去就算数，
    //    所以对任何平台都可能非零（自动归类进不去 ≠ 用户进不去）。
    const caps = c => PF.supports(state.platform, c);
    const cards = [{ label: '已拥有', value: owned, unit: '款' }];
    if (caps('wishlist')) cards.push({ label: '未入库', value: wished, unit: '款' });
    if (caps('playtime')) {
      cards.push({ label: '总时长', value: Math.round(totalMin / 60), unit: '小时' });
      cards.push({ label: '玩过', value: played, unit: '款' });
    } else if (caps('installed')) {
      cards.push({ label: '已安装', value: installedN, unit: '款' });
      cards.push({ label: '占用空间',
                   value: Math.round(installedBytes / 1073741824 * 10) / 10, unit: 'GB' });
    }
    cards.push({ label: '正在玩', value: playing, unit: '款' });
    cards.push({ label: '待玩', value: backlog, unit: '款' });
    if (caps('achievements')) cards.push({ label: '全成就', value: perfect, unit: '款' });

    el.statsBar.innerHTML = cards.map(c =>

      '<div class="stat">' +
        '<div class="stat-label">' + esc(c.label) + '</div>' +
        '<div class="stat-value">' + c.value + '<small>' + esc(c.unit) + '</small></div>' +
      '</div>'
    ).join('');
  }

  /**
   * 顶栏那行小字（`.brand` 里的区块副标题）。
   *
   * 🔴 **不能直接用 `META[st].desc`** —— `store.js` 那张表里「我的游戏单」写死了
   *    `'Steam 库 + 愿望单，全在这里'`，而切到 EPIC 时这两样**一个都没有**：
   *    标题栏会挂着"Steam 库 + 愿望单"，下面的统计和卡片却全是 EPIC 的。
   *    这就是"标题和内容各说各的平台"，出图时实测看到了（`_shot_platform_epic.png` 那一栏）。
   *
   * ⚠️ 只改「我的游戏单」这一条：其余五条说的是**分桶规则本身**
   *    （"90 天内启动过" / "超过 90 天没启动"…），规则在任何平台上都成立，
   *    只是没有 `lastPlayed` 的平台**永远不会有记录自动落进去** —— 那不是假话。
   */
  function viewDesc(st) {
    const m = META[st] || META[S.LIBRARY];
    if (st === S.LIBRARY && !PF.supports(state.platform, 'wishlist')) {
      return '这个平台的全部游戏，都在这里';
    }
    return m.desc;
  }

  // ===== 渲染：平台切换（一级导航）=====
  /**
   * 平台标签页。**完全由注册表渲染**（js/platforms.js）——
   * 加一个平台只改那个文件，这个函数和 index.html 一行都不用动。
   */
  function renderPlatformTabs() {
    if (!el.platTabs) return;
    el.platTabs.innerHTML = PF.all().map(p => {
      const on = p.id === state.platform;
      // 还没接数据源的平台在标签上就说清（点开还有一段更详细的"缺什么"）
      const soon = p.available ? '' : '<span class="ptab-soon">未接入</span>';
      const tip = p.available ? p.label : (p.label + '：' + (p.unavailableWhy || '尚未接入'));
      return '<button class="ptab' + (on ? ' on' : '') + (p.available ? '' : ' off') + '"' +
             ' type="button" role="tab" aria-selected="' + (on ? 'true' : 'false') + '"' +
             ' data-plat="' + esc(p.id) + '"' +
             ' style="--ptab-c:' + esc(p.color) + '"' +
             ' title="' + esc(tip) + '">' +
               '<span class="ptab-mark">' + esc(p.mark) + '</span>' +
               esc(p.short) + soon +
             '</button>';
    }).join('');

    el.platTabs.querySelectorAll('.ptab').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.plat === state.platform) return;
        // 换平台 = 换了一整份数据：跨平台的"已选中"没有任何意义，清掉
        // （和 renderNav 里换区块时同一个理由）。
        exitSelectMode();
        state.platform = btn.dataset.plat;
        render();
        // 这个平台有数据源、而且这一趟会话里还没探过 → 顺手**只读**探一次，
        // 好让占位区能立刻说出"本机有什么 / 为什么读不到"，而不是先空着等用户去点同步。
        // ⚠️ 只是探测，**不写库**（见 runPlatformProbe 上面那段）。
        const src = PF.sourceOf(state.platform);
        if (src && !state.platNote[state.platform]) runPlatformProbe(src, state.platform);
      });
    });
  }

  /**
   * 排序按钮：按当前平台**能给的能力**决定显示哪几个（能力表见 js/platforms.js）。
   *
   * ⚠️ 用 `hidden` 而不是重建 DOM：这些按钮的点击监听是 bindEvents 里一次性挂上的，
   *    重建会把它们一起扔掉 —— 和筛选面板那组选项踩过的是同一个坑。
   */
  function renderSortSeg() {
    if (!el.sortSeg) return;
    const cur = effectiveSort();
    el.sortSeg.querySelectorAll('button').forEach(b => {
      b.hidden = !PF.supports(state.platform, SORT_CAP[b.dataset.sort]);
      b.classList.toggle('on', b.dataset.sort === cur);
    });
  }

  /**
   * 「这个平台还没接入」时，占位区里那几句话。
   * 内容**全部来自注册表声明** —— 不在这里写死任何平台名或字段清单，
   * 否则真接进来那天，这段文案就会留下来继续骗人。
   */
  function platformSoonText(p) {
    const got = (p.capabilities || []).map(PF.capLabel);
    const miss = (p.missing || []).map(PF.capLabel);
    // ⚠️ 第一句必须自带句末标点：这三句是拼成**一整段**给用户看的，
    //    `unavailableWhy` 是注册表里手写的、结尾有没有句号全看当时心情 ——
    //    缺一个句号就会出现「…再谈登录后取全量库接入后能拿到：…」这种粘在一块的句子
    //    （出图时就是这个样子）。这里补一刀，别去要求每条声明都自己写标点。
    let why = p.unavailableWhy || (p.label + ' 还没接入数据源');
    if (!/[。！？]$/.test(why)) why += '。';
    const s = [why];
    if (got.length) s.push('接入后能拿到：' + got.join('、') + '。');
    if (miss.length) s.push('拿不到：' + miss.join('、') + '（这些地方会留空、或退回手动填写）。');
    return s.join('');
  }

  // ===== 平台数据源：探一次 / 同步一次 =====
  //
  // 🔴 「探一次」和「同步一次」是**两个**动作，不许合并成一个。
  //    切标签页是**导航**，不是操作 —— 做成"切过去就自动导入"，就是在用户没下过
  //    任何指令的情况下替他写数据；出问题的时候没人知道是谁写的、什么时候写的。
  //    所以：切过去只**读**（`probe`，一个字节都不落盘），导进来要用户点「同步」。
  //
  // ⚠️ 这两个函数**完全不认识任何平台名** —— 它们只面对"一个数据源"，
  //    具体是哪个平台由注册表回答（`PF.sourceOf`）。加第三个平台时这里一行不用改。
  let platBusy = false;

  /** 只读探一次当前平台的本机数据源，结果记进 `state.platNote`。**不写任何数据。** */
  async function runPlatformProbe(src, pid) {
    const cur = state.platNote[pid];
    if (cur && cur.state === 'loading') return;   // 已经在读了，别叠
    if (!src.probe) return;                        // 数据源没实现探测：什么都不说
    state.platNote[pid] = { state: 'loading', text: src.loadingText || '正在读取…' };
    if (state.platform === pid) render();
    let r = null;
    try {
      r = await src.probe();
    } catch (e) {
      r = { ok: false, text: '读取失败：' + ((e && e.message) || e) };
    }
    state.platNote[pid] = { state: r && r.ok ? 'ready' : 'fail',
                            text: (r && r.text) || '' };
    // 读的过程中用户可能已经切走了 —— 那时只记结果，别去动别人的界面
    if (state.platform === pid) render();
  }

  /** 真同步一次（**会写库**）。给用户看的话一律用数据源给的那句，界面不自己编。 */
  async function runPlatformSync(src) {
    if (platBusy) return;                          // 按钮能连点，别叠起来跑
    platBusy = true;
    const pid = state.platform;
    state.platNote[pid] = { state: 'loading', text: src.loadingText || '正在读取…' };
    render();
    let r = null;
    try {
      r = await src.sync();
    } catch (e) {
      r = { ok: false, text: '同步失败：' + ((e && e.message) || e) };
    }
    platBusy = false;
    state.platNote[pid] = { state: r && r.ok ? 'ok' : 'fail', text: (r && r.text) || '' };
    // ⚠️ 同上：切走了就只记结果。拿旧平台的结论去改新平台的界面，
    //    症状是"切过去看到的是另一个平台的状态"——看着像数据串了，最难查。
    if (state.platform !== pid) return;
    if (r && r.ok) {
      await reload();                              // reload 只刷 state.games，不重绘
      note(r.text || (PF.labelOf(pid) + ' 同步完成'), 'ok');
    } else {
      note(r.text || (PF.labelOf(pid) + ' 没读出来'), 'err');
    }
    render();
  }

  // ===== 渲染：侧栏导航 =====
  function renderNav() {
    const items = [];

    items.push(navHtml(S.LIBRARY, '📚'));

    items.push('<div class="nav-sep"></div>');

    DS.VIEW_ORDER.forEach(st => items.push(navHtml(st)));

    el.viewNav.innerHTML = items.join('');

    el.viewNav.querySelectorAll('.navitem').forEach(btn => {
      btn.addEventListener('click', () => {
        // 换区块时退出批量选择：不同区块的选中共存会让人搞不清在选什么
        if (btn.dataset.st !== state.view) exitSelectMode();
        state.view = btn.dataset.st;
        render();
      });
    });

    // 图例
    el.legend.innerHTML = DS.VIEW_ORDER.map(st =>
      '<div class="legend-item">' +
        '<span class="legend-dot" style="background:' + statusColor(st) + '"></span>' +
        esc(META[st].label) +
      '</div>'
    ).join('');
  }

  // ============================================================
  // 界面选项的持久化（筛选开关 + 排序 + 全成就分组）
  // ============================================================
  //
  // 🔴 为什么要有（2026-09-24 用户实测投诉）：
  //    「筛选选项我每次启动后都默认是隐藏家庭库…我手动修改并退出后，我修改的
  //      筛选选项不保存，每次启动都必须要重新设置」。
  //    根因：`state` 里这几个开关**只活在内存里** —— 全项目搜一遍，没有任何一处
  //    把它们写进 localStorage / IndexedDB，于是每次启动都回落到默认值。
  //    （`state.filterOpen` 是例外：「面板展开没展开」是纯瞬时状态，**故意不存**。）
  //
  // 存哪儿：单独一个键。**故意不并进 `store.js` 的 `gv_prefs_v1`**，两个理由：
  //   · 那份 prefs 是「哪个 Steam 收藏夹算「已通关」」的**数据语义**配置，会被
  //     备份导出带上、被导入时的 `DS.setPrefs(data.prefs)` 生效 —— 把界面开关塞进去，
  //     等于「导入一份别人的备份顺手改掉自己的界面」；
  //   · 这一份丢了只影响观感，不该跟任何数据有连锁。
  //
  // 🔴 与 URL 参数的关系：**URL 参数优先**。`?hidedone=1` 这类是「这一次打开就要
  //    这样」的明确指令（也给自动化验收留的入口），不能被上次存下来的值盖掉。
  //    所以 `boot()` 里的顺序是：**先读存档 → 再让 URL 参数覆盖**。
  //
  // ⚠️ 边界（刻意的）：**`view`（当前在哪个区块）不存**。区块切换是"导航"，
  //    而这里存的是"这个区块该怎么显示"。启动落在「正在游玩」是既有设计
  //    （空库时会自动退到「待游玩」），改成"上次停在哪就回哪"会让人一打开
  //    就掉进「已通关」这类次级区块里，反而更难回到主界面。
  const UI_KEY = 'gv_ui_v1';

  /** 会被记住的选项 —— 与下面 `filterToggles()` 一一对应，外加减少了排序与全成就分组 */
  const UI_BOOL_KEYS = ['hideTools', 'hideCompleted', 'hideAbandoned', 'hideFamily',
                        'groupPerfect'];

  function loadUiPrefs() {
    let saved = null;
    try {
      const raw = window.localStorage.getItem(UI_KEY);
      saved = raw ? JSON.parse(raw) : null;
    } catch (e) {
      // 隐私模式 / 禁用存储 / 存档被手改坏成非法 JSON —— 一律用默认值继续，
      // 这里**绝不能抛**：它跑在 boot 最前面，抛出去就是整个界面起不来。
      saved = null;
    }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return false;

    // 逐项**显式**校验类型，别用 `if (saved[k])`：
    // 这份存档是用户机器上的字符串，可能是旧版本写的、也可能被手改过。
    // 一个 `"hideTools": "false"`（字符串）在真值判断下会被当成 `true` ——
    // 而症状是"我明明没开这个开关，它却总是开着"，属于最难查的那类"改了不见效"。
    UI_BOOL_KEYS.forEach(k => {
      if (typeof saved[k] === 'boolean') state[k] = saved[k];
    });
    // 排序要落在白名单里：旧版本可能存过一个后来被删掉的排序键，
    // 直接用会让 `sortGames` 走进没有分支的 default（列表顺序会变得莫名其妙）。
    if (SORTS.indexOf(saved.sort) >= 0) state.sort = saved.sort;
    return true;
  }

  function saveUiPrefs() {
    const snap = { sort: state.sort };
    UI_BOOL_KEYS.forEach(k => { snap[k] = !!state[k]; });
    try { window.localStorage.setItem(UI_KEY, JSON.stringify(snap)); }
    catch (e) { /* 存不下就算了 —— 界面开关丢了不影响任何数据 */ }
  }

  /**
   * 总表（我的游戏单）的三个过滤开关：隐藏非游戏 / 隐藏已通关 / 隐藏已放弃。
   * 三者互相独立、可叠加；数量为 0 的开关不显示；只与总库有关，其他区块整个隐藏。
   *
   * 位置：常驻只留标题行右侧一个「筛选」按钮（有开关生效时按钮变亮并显示个数），
   * 点开后选项展开在标题下方 —— 也就是原来排序栏与第一排卡片之间那截空白处。
   * 这样收起时**不占任何高度**，展开的选项又正好落在本来就空着的地方。
   */
  function filterToggles() {
    return [
      { id: 'toggleTools', n: hiddenCount(),     on: state.hideTools,     label: '非游戏',
        tip: '工具/软件，以及藏在 Steam「已隐藏」收藏夹里的游戏',
        run: () => { state.hideTools = !state.hideTools; } },
      { id: 'toggleDone',  n: completedCount(),  on: state.hideCompleted, label: '已通关',
        tip: '状态为「已通关」的游戏',
        run: () => { state.hideCompleted = !state.hideCompleted; } },
      { id: 'toggleDrop',  n: abandonedCount(),  on: state.hideAbandoned, label: '已放弃',
        tip: '状态为「放弃区」的游戏',
        run: () => { state.hideAbandoned = !state.hideAbandoned; } },
      // 「家人拥有」：家庭共享里、**你账号并不拥有**的款（`source='family'`）。
      // 措辞必须是"家人拥有"而不是"已拥有" —— 它们来自家庭成员的公开库，
      // 而且 Steam Families 有不可共享的项，所以严格说只是"家人有这些"。
      { id: 'toggleFamily', n: familyCount(),    on: state.hideFamily,    label: '家人拥有',
        tip: '家庭共享里、你账号并不拥有的款（来自家庭成员的公开库）',
        run: () => { state.hideFamily = !state.hideFamily; } }
    ].filter(t => t.n > 0);
  }

  /**
   * 选项按钮**只建一次**，之后每次 render 只改文字和亮不亮。
   *
   * ⚠️ 不能每次 render 都把面板 innerHTML 重写一遍：点某个选项时，它自己的
   *    处理函数先同步跑 render() → 按钮被换成新节点 → 紧接着事件冒泡到
   *    document 上那条「点面板外就收起」的监听，而那个旧节点已经从面板里摘掉了，
   *    `el.filterPanel.contains(e.target)` 判成 false → 面板自己弹回去
   *    （实测症状：点一下选项，筛选生效了、角标也出来了，但面板瞬间收起，
   *      想连开两个条件得重新点开一次）。同理，收起时也不能清空 innerHTML，
   *    只把它 hidden 掉就行。
   */
  const chipEls = {};

  function chipFor(id) {
    let b = chipEls[id];
    if (b) return b;
    b = document.createElement('button');
    b.className = 'tooltoggle';
    b.id = id;
    b.addEventListener('click', () => {
      const t = filterToggles().find(x => x.id === id);
      if (t) t.run();
      // 开关一改就落盘 —— 不能等到关窗再存（桌面版可能被直接 kill，
      // 浏览器版也没有可靠的"退出前"事件），见 UI_KEY 那段。
      saveUiPrefs();
      render();
    });
    el.filterPanel.appendChild(b);
    chipEls[id] = b;
    return b;
  }

  function renderFilters() {
    if (!el.filterBtn) return;
    const toggles = filterToggles();
    const show = state.view === S.LIBRARY && toggles.length > 0;

    el.filterBtn.hidden = !show;
    el.filterPanel.hidden = !show || !state.filterOpen;
    if (!show) return;

    const activeN = toggles.filter(t => t.on).length;
    el.filterBtn.classList.toggle('on', activeN > 0);
    el.filterBadge.textContent = activeN ? String(activeN) : '';
    el.filterBadge.hidden = !activeN;
    el.filterBtn.setAttribute('aria-expanded', state.filterOpen ? 'true' : 'false');

    const want = {};
    toggles.forEach(t => {
      const b = chipFor(t.id);
      want[t.id] = true;
      b.hidden = false;
      b.textContent = (t.on ? '👁 显示' : '🙈 隐藏') + t.label + ' ' + t.n;
      b.title = t.tip;
      b.classList.toggle('on', t.on);
    });
    // 计数掉到 0 的选项藏起来（不是删掉，删了下次还得重建）
    Object.keys(chipEls).forEach(id => { if (!want[id]) chipEls[id].hidden = true; });
  }

  function navHtml(st) {
    const m = META[st];
    const on = state.view === st ? ' on' : '';
    return '<button class="navitem' + on + '" data-st="' + st + '" ' +
             'style="--navc:' + m.color + '">' +
             '<span class="navdot"></span>' +
             '<span class="navlabel">' + esc(m.label) + '</span>' +
             '<span class="navcount">' + countOf(st) + '</span>' +
           '</button>';
  }

  /**
   * 卡面 / 详情页**显示用**的标题（返回 {text, pending, tip}）。
   *
   * 愿望单接口**不给名字**（只给 appid），所以刚导入的款 `title` 是空的。
   * 直接渲染空标题会得到一张「说不清是哪款游戏」的空白卡 —— 这里退化成
   * `App <appid>` 占位，用户至少能照着 appid 去 Steam 搜到它。
   *
   * ⚠️ **纯显示，绝不写回数据**：真把 "App 123" 写进 title，就会顺着公共缓存
   * `game_meta` 被当成真名字污染全站（`_t_wish.html` 的 A1 断言钉着这条）。
   */
  function titleOf(g) {
    if (!g) return { text: '', pending: false, tip: '' };
    if (g.title) return { text: g.title, pending: false, tip: g.title };
    if (g.appid == null) return { text: '', pending: false, tip: '' };
    return { text: 'App ' + g.appid, pending: true, tip: '名称待补全（同步时会自动补上）' };
  }

  // ===== 渲染：卡片 =====
  function cardHtml(g, opts) {
    const m = META[g.status] || META[S.LIBRARY];
    const hours = fmtHours(g.totalMinutes);
    const titleInfo = titleOf(g);
    const perfect = DS.isPerfect(g);
    const ach = g.achievements;
    const showStatus = !(opts && opts.hideStatus);
    const showQuick = !!(opts && opts.quick);
    const inBacklog = g.status === S.BACKLOG;

    let badges = '';
    if (perfect) {
      badges += '<span class="badge badge-perfect">🏆 全成就</span>';
    } else if (ach && ach.total > 0) {
      const pct = Math.round(ach.earned / ach.total * 100);
      if (pct > 0) badges += '<span class="badge badge-pct">' + pct + '%</span>';
    }

    // 状态来源标记：单独放在封面左下角，不与右上角的成就徽章挤在一起
    let autoFlag = '';
    if (g.statusLocked) {
      autoFlag = '<span class="cflag cflag-lock" title="状态已锁定，不参与自动归类">🔒 锁定</span>';
    } else if (g.status === S.ABANDONED) {
      autoFlag = '<span class="cflag cflag-drop" title="已放弃：手动终态，同步时不会被改动">🗑️ 已放弃</span>';
    } else if (g.autoStatus && (g.status === S.PLAYING || g.status === S.PAUSED)) {
      const d = DS.daysSincePlayed(g);
      const tip = d >= 0
        ? '按启动日期自动归类（最后启动：' + Math.floor(d) + ' 天前）'
        : '按启动日期自动归类';
      autoFlag = '<span class="cflag cflag-auto" title="' + esc(tip) + '">自动</span>';
    }

    // 「疑似已放弃」：只是提示，不参与任何自动归类
    //（「不想再玩了」是主观判断，数据推不出来 —— 所以只挂个淡色角标提醒你去处理）
    let staleFlag = '';
    if (DS.isStale(g)) {
      const d = Math.floor(DS.daysSincePlayed(g));
      staleFlag = '<span class="cflag cflag-stale" title="' +
                    esc('最后启动在 ' + d + ' 天前 —— 如果确定不会再玩了，可以移入「放弃区」') +
                  '">疑似已放弃</span>';
    }

    // 左下角标记容器：多个角标时垂直堆叠，不互相遮挡
    const flags = (autoFlag || staleFlag)
      ? '<div class="card-flags">' + autoFlag + staleFlag + '</div>'
      : '';

    // 右下角：拥有状态（已拥有 / 未入库 / 家人的 · 名字）。
    // 只在「我的游戏单」和「待游玩」两个区块渲染 —— 这两个区块里已拥有和
    // 愿望单来的款会混在一起，角标才有信息量。其余区块清一色都是已拥有的，
    // 每张卡都挂一个「已拥有」只是噪声。
    // DS.ownershipOf 对手动添加的款返回空串（判断不了就不标），见 store.js。
    const own = DS.ownershipOf(g);
    let ownText = '';
    let ownTip = '';
    if (own === 'owned') {
      ownText = '已拥有';
    } else if (own === 'wish') {
      ownText = '未入库';
    } else if (own === 'family') {
      // 家庭款要**点名**是谁的：「家人拥有」四个字不够用 —— 一个家庭好几个人，
      // 用户真正想知道的是"这款能玩是靠谁"。名字太长就截断（角标在卡片右下角，
      // 撑宽了会压到封面上），完整的名单放 `title` 和详情页里。
      const names = (g.familyOwners || []).map(o => o && o.name).filter(Boolean);
      if (names.length) {
        const first = names[0];
        ownText = '家人的 · ' + (first.length > 5 ? first.slice(0, 5) + '…' : first) +
                  (names.length > 1 ? ' 等 ' + names.length + ' 人' : '');
        ownTip = '家庭共享里这款是' + names.join('、') + '的 —— 你账号并不拥有它';
      } else {
        // 名单丢了也别显示「家人的 · 」这种半截话。
        // 真实会走到这里的场景：桌面版导出备份 → 导进云端版（云端表里没有
        // `familyOwners` 这两列，见 DESIGN.md 那条已知限制）。
        ownText = '家人拥有';
        ownTip = '家庭共享里的款 —— 你账号并不拥有它';
      }
    }
    const ownFlag = (own && (state.view === S.LIBRARY || state.view === S.BACKLOG))
      ? '<div class="card-corner"><span class="cflag cflag-' + own + '"' +
          (ownTip ? ' title="' + esc(ownTip) + '"' : '') + '>' + esc(ownText) + '</span></div>'
      : '';

    // 批量选择模式才渲染勾选圈（避免平时白占几百个 DOM 节点）
    const showCheck = !!(opts && opts.selected);
    const isSel = !!(opts && opts.selected && opts.selected[g.id]);

    // 封面：画框比例写死 460/215，素材比例不定 → 一律 contain（永不裁），
    // 比例对不上的由 GVCoverFit 挂 pad 类铺模糊底（见 js/coverfit.js）
    const img = g.header
      ? '<img src="' + esc(g.header) + '" alt="" loading="lazy" ' +
        'onload="GVCoverFit.apply(this)" ' +
        // 🔴 加载失败时**只换掉这个 img 自己**（`this.outerHTML=`），**绝不能**写
        //    `this.parentNode.innerHTML=` —— `parentNode` 是 `.card-media`，那一下会把
        //    兄弟节点一起清空：`card-badges`（全成就）、`card-quick`（快捷收藏）、
        //    `card-flags`（自动角标）、以及右下角的拥有状态角标 `ownFlag`
        //    （已拥有 / 未入库 / 家人的）**全部消失**。
        //    实测症状：代理一挂、封面全 404 → 400+ 张卡里「已拥有」角标数从 400 多掉到 **0**
        //    （`_t_wish.html` B2 因此间歇性假红：同一份代码跑出 37/2 与 39/0 两种结果）。
        //    注意外层属性用的是单引号，所以内层 HTML 的双引号写成 `&quot;`。
        'onerror="this.outerHTML=\'<div class=&quot;noimg&quot;>◈</div>\'">'
      : '<div class="noimg">◈</div>';

    // 快捷收藏按钮（只在「我的游戏单」里出现）
    const quickBtn = showQuick
      ? '<button class="card-quick' + (inBacklog ? ' on' : '') + '" ' +
          'data-quick="' + esc(g.id) + '" ' +
          'title="' + (inBacklog ? '已在待玩清单，点击移出' : '加入待玩清单') + '">' +
          (inBacklog ? '★' : '☆') +
        '</button>'
      : '';

    // 卡面那一格数字：能按时长的平台给时长，**给不出的平台换一件它确实有的事**。
    //
    // 🔴 为什么不能继续画「—」：注册表里没声明 `playtime` 能力的平台（EPIC 就是），
    //    `totalMinutes` 恒为 0 → 每张卡都是「—」。用户看到的是"你玩了 0 小时"，
    //    而事实是"这个平台没有时长数据"—— 两件事在界面上长得一模一样、含义正好相反。
    //    和详情页里"愿望单的款换一组指标"是同一类问题、同一种解法。
    // `installed` 也没有的平台（将来的）→ 这一格留空，比一个假的 0 好。
    const hoursCell = PF.supports(state.platform, 'playtime')
      ? '<span class="card-hours">' +
          (hours ? '<b>' + hours + '</b> h' : '&mdash;') +
        '</span>'
      : (PF.supports(state.platform, 'installed')
          ? '<span class="card-inst' + (g.installed ? ' on' : '') + '">' +
              (g.installed ? '已安装' : '未安装') +
            '</span>'
          : '');

    return '<article class="card' + (isSel ? ' sel' : '') + '" data-id="' + esc(g.id) +
             '" style="--stc:' + m.color + '">' +
      '<div class="card-media">' + img +
        (badges ? '<div class="card-badges">' + badges + '</div>' : '') +
        quickBtn +
        flags +
        ownFlag +
        (showCheck ? '<span class="card-check">✓</span>' : '') +
      '</div>' +
      '<div class="card-statusbar"></div>' +
      '<div class="card-body">' +
        '<div class="card-title' + (titleInfo.pending ? ' pending' : '') +
          '" title="' + esc(titleInfo.tip) + '">' + esc(titleInfo.text) + '</div>' +
        '<div class="card-meta">' +
          hoursCell +
          (showStatus
            // 状态文字包一层 .pill-label：手机端（≤620px）一行放 3 张卡时宽度不够，
            // 只留图标。区块内每张卡的状态必然相同，文字本来就是重复信息。
            ? '<span class="card-status-pill">' + esc(m.icon)
                + '<span class="pill-label">' + esc(m.label) + '</span></span>'
            : (g.releaseYear ? '<span class="card-year">' + g.releaseYear + '</span>' : '')) +
        '</div>' +
      '</div>' +
    '</article>';
  }

  // ===== 渲染：主视图 =====
  function render() {
    // 平台是最外面那一层：它决定下面所有数字算谁的数据，所以先渲染它
    renderPlatformTabs();
    renderStats();
    renderNav();
    renderFilters();
    renderSortSeg();

    const pNow = PF.get(state.platform);
    const m = META[state.view] || META[S.LIBRARY];
    // 非默认平台时把平台名缀在区块名前面。不缀的话，切到 EPIC 还写着「正在游玩」，
    // 而下面的统计和卡片**已经是 EPIC 的**了 —— 标题和内容各说各的平台。
    el.viewTitle.textContent =
      (state.platform === PF.DEFAULT_ID ? '' : PF.labelOf(state.platform) + ' · ') + m.label;
    el.brandSub.textContent = viewDesc(state.view);

    const list = gamesInView();
    el.viewCount.textContent = list.length ? list.length + ' 款' : '';

    // 在「我的游戏单」这个总表里，卡片改成显示发售年份（更利于浏览大库）
    // 并开启快捷收藏按钮
    const cardOpts = {
      hideStatus: state.view === S.LIBRARY,
      quick: state.view === S.LIBRARY || state.view === S.BACKLOG,
      // 批量选择模式：把已选中的 id 集合传下去，重绘时保留勾选态
      selected: state.selectMode ? state.selected : null
    };

    if (list.length) {
      el.grid.hidden = false;
      el.emptyState.hidden = true;
      el.grid.innerHTML = gridHtml(list, cardOpts);
    } else {
      el.grid.hidden = true;
      el.emptyState.hidden = false;
      // 空态分**三**种，不许混成一句：
      //   ① 这个平台还没接数据源（注册表里 available:false）→ 说清它缺什么；
      //   ② 接了数据源，但这台机器上读不到（没装 / 不是桌面版）→ 说清为什么；
      //   ③ 数据读得到，只是这个区块暂时没东西 → 原来那句"这里还空着"。
      // ③ 写成 ② 会让用户以为自己的库丢了；② 写成 ③ 会让他对着空页面反复点同步。
      const note = pNow ? state.platNote[pNow.id] : null;
      if (pNow && !pNow.available) {
        el.emptyTitle.textContent = pNow.label + ' 尚未接入';
        el.emptyHint.textContent = platformSoonText(pNow);
      } else if (note && (note.state === 'loading' || note.state === 'fail'
                          || note.state === 'ready')) {
        el.emptyTitle.textContent =
          note.state === 'loading' ? ('正在读 ' + pNow.label + ' 的本机库…')
          : note.state === 'fail' ? (pNow.label + ' 的本机数据没读出来')
          : ('本机 ' + pNow.label + ' 的数据还没导进来');
        el.emptyHint.textContent = note.text || '';
      } else {
        el.emptyTitle.textContent = '这里还空着';
        el.emptyHint.textContent = state.search
          ? '没有匹配「' + state.search + '」的游戏。'
          : emptyHintFor(state.view);
      }
    }

    // 当前平台还没接数据源（注册表里 available:false）→ 写操作一律置灰。
    //
    // 理由：这两个动作现在**只有 Steam 语义**（「添加」问的是 Steam AppID、
    // 「同步」读的是本机 Steam 文件）。在一个还没有数据源的平台上放开它们，
    // 产出的是一条"归属说不清"的记录 —— 用户明明站在 EPIC 标签页里点添加，
    // 建出来的条目却落在 Steam 那边，他只会觉得"加了看不到"。
    // 阶段 2 把 EPIC 的 available 置真后，这里**自动一起放开**，不用改这个函数。
    // 两个写操作按**各自的条件**开放，不是一个 `writable` 管两个：
    //
    //   · 「添加」看平台声明里的 `manualAdd` —— 那个表单是**某一个平台的语义**
    //     （问的是它的商品号、搜的是它的商店、封面按它的 URL 拼）。在没有声明它的
    //     平台上放开，建出来的记录 `platform` 是缺省的、于是落进默认平台，
    //     用户明明站在别的标签页里点添加，却"加了看不到"。
    //   · 「同步」看**有没有数据源**（`PF.sourceOf`）。有数据源就一定能读，
    //     剩下的交给数据源自己回答"读不读得到、为什么"。
    //
    // ⚠️ 平台名一个都不在这段里 —— 条件全来自注册表。
    const src = pNow ? PF.sourceOf(pNow.id) : null;
    const canAdd = !!(pNow && pNow.manualAdd);
    const canSync = !!(pNow && (pNow.available || src));
    if (el.btnAdd) {
      el.btnAdd.disabled = !canAdd;
      el.btnAdd.title = canAdd ? '手动添加游戏'
        : ((pNow ? pNow.label : '') + ' 目前只能从它的本机库同步，不提供手动添加');
    }
    if (el.btnSync) {
      el.btnSync.disabled = !canSync;
      // ⚠️ 文案由**平台名**拼出来（不是写死的"从 Steam 同步"）——
      //    写死的话，切到别的平台按钮上还写着 Steam，用户会以为按错了按钮。
      el.btnSync.title = canSync
        ? ('从 ' + PF.labelOf(pNow.id) + ' 同步')
        : ((pNow ? pNow.label : '') + ' 还没有数据源，暂时不能同步');
    }

    // 分组开关：只在「已通关」区出现（其他地方分组没意义）
    if (el.groupPerfectBtn) {
      const canGroup = state.view === S.COMPLETED;
      el.groupPerfectBtn.hidden = !canGroup;
      el.groupPerfectBtn.classList.toggle('on', canGroup && state.groupPerfect);
      el.groupPerfectBtn.textContent = state.groupPerfect ? '分组：全成就 ✓' : '分组：全成就';
    }

    // 批量选择入口：只在「暂停区」出现
    //（暂停区是清理"不想再玩了"的主战场；进了选择模式后由选择条接管，按钮让位）
    if (el.selectModeBtn) {
      const canSelect = state.view === S.PAUSED && list.length > 0;
      el.selectModeBtn.hidden = !canSelect || state.selectMode;
      el.selectModeBtn.textContent = '批量选择';
    }

    // 绑定卡片点击
    el.grid.querySelectorAll('.card').forEach(c => {
      c.addEventListener('click', (e) => {
        // 快捷按钮单独处理，不打开详情
        if (e.target.closest('.card-quick')) return;
        // 选择模式下：点卡片 = 勾选/取消，不打开详情
        if (state.selectMode) { toggleSelect(c); return; }
        openDrawer(c.dataset.id);
      });
    });

    // 绑定快捷收藏
    el.grid.querySelectorAll('.card-quick').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const g = state.games.find(x => x.id === btn.dataset.quick);
        if (!g) return;
        // 在待玩 <-> 我的游戏单 之间切换
        const toBacklog = g.status !== S.BACKLOG;
        g.status = toBacklog ? S.BACKLOG : S.LIBRARY;
        g.manualStatus = g.status;
        g.statusManualAt = Math.floor(Date.now() / 1000);
        g.autoStatus = false;
        // 从「已通关」被挪走时同样记迟滞标记，避免下次同步被拉回
        if (toBacklog && DS.inCompletedCollection(g)) g.dismissedCollection = true;
        g.updatedAt = Date.now();
        await DS.save(g);
        await reload();
        render();
      });
    });

    // 排序按钮态：挪到 renderSortSeg()（它还要按平台能力决定显示哪几个按钮），
    // 在 render() 开头和平台标签一起渲染。

    // 这句话必须说实话：桌面版的数据在本机 Steam 文件里，不是「本机浏览器」。
    // 桌面版的数据源（local-src.js）会挂上 window.__gvStorageNote 说明它从哪来；
    // 没挂就是双击 index.html 打开的那种本地版 —— 那时数据确实在浏览器存储里。
    const storageNote = window.__gvStorageNote || '数据保存在本机浏览器';
    // 拆开说：总条数里混着愿望单的、还有家人拥有的，只报一个「共 N 款」会让人以为库变大了。
    // ⚠️ 「家人拥有」既不算「已拥有」也不算「愿望单」—— 它是**别人的**游戏，
    //    必须单独一个数，否则页脚会凭空多出几百款。
    const nFamily = familyCount();
    const nOwned = platformGames().filter(g => g.source !== 'wishlist' && g.source !== 'family').length;
    const nWish = platformGames().filter(g => g.source === 'wishlist').length;
    el.footInfo.textContent = '已拥有 ' + nOwned + ' 款'
      + (nWish ? ' · 愿望单 ' + nWish + ' 款' : '')
      + (nFamily ? ' · 家人拥有 ' + nFamily + ' 款' : '')
      + ' · ' + storageNote;

    renderSelbar();
  }

  // ===== 批量选择（暂停区里批量移入放弃区）=====
  /**
   * 切换单张卡片的选中态。
   * 只 toggle class + 更新计数，**不重绘整个网格** —— 暂停区上百张卡，
   * 每点一下就全量重绘会闪、还会丢失滚动位置。
   */
  function toggleSelect(cardEl) {
    const id = cardEl.dataset.id;
    if (state.selected[id]) {
      delete state.selected[id];
      cardEl.classList.remove('sel');
    } else {
      state.selected[id] = true;
      cardEl.classList.add('sel');
    }
    renderSelbar();
  }

  /** 刷新选择条（已选数量 / 按钮可用态），不重绘网格 */
  function renderSelbar() {
    if (!el.selbar) return;
    el.selbar.hidden = !state.selectMode;
    if (!state.selectMode) return;
    const n = Object.keys(state.selected).length;
    const total = gamesInView().length;
    el.selbarCount.textContent = '已选 ' + n + ' / ' + total + ' 款';
    el.selDropBtn.disabled = n === 0;
    el.selAllBtn.textContent = (total > 0 && n >= total) ? '取消全选' : '全选';
  }

  /** 全选 / 取消全选（这里必须重绘：一次性批量改太多卡片，逐个 toggle 反而慢） */
  function toggleSelectAll() {
    const list = gamesInView();
    const n = Object.keys(state.selected).length;
    const all = n >= list.length && list.length > 0;
    state.selected = {};
    if (!all) list.forEach(g => { state.selected[g.id] = true; });
    render();
  }

  /** 把选中的游戏批量移入「放弃区」 */
  async function dropSelected() {
    const ids = Object.keys(state.selected);
    if (!ids.length) return;
    if (!confirm('把选中的 ' + ids.length + ' 款游戏移入「放弃区」？\n\n' +
                 '放弃区是手动终态：之后同步不会再自动改动它们。\n' +
                 '反悔的话，点开卡片改个状态就能挪回来。')) return;

    const now = Math.floor(Date.now() / 1000);
    const touched = [];
    ids.forEach(id => {
      const g = state.games.find(x => x.id === id);
      if (!g) return;
      g.status = S.ABANDONED;
      g.manualStatus = S.ABANDONED;
      g.statusManualAt = now;
      g.autoStatus = false;
      g.updatedAt = Date.now();
      touched.push(g);
    });

    await DS.saveMany(touched);
    exitSelectMode();
    await reload();
    render();
  }

  /**
   * 「这个区块空着」时那句提示。
   *
   * 🔴 文案**按能力拼**，不写死。这里原来是"点「同步」载入 Steam 库，或点「添加」手动录入"，
   *    那句话在 EPIC 标签页上同时错了三处：这个平台读的不是 Steam、没有愿望单、
   *    而且「添加」是**灰的**（`manualAdd:false`）。出图时实测看到的就是这一屏
   *    （`_shot_platform_epic.png`）—— 用户会照着一条走不通的指引去折腾。
   *    它同时还是 `ui.js` 里最后一处**平台名字面量**（"平台差异只写在 js/platforms.js"
   *    这条规则的漏网之处，正则断言拦不住字符串里的名字，只能靠这个函数自己守）。
   *
   * ⚠️ 「正在游玩 / 暂停区」的自动归类**依赖 `lastPlayed`**：没有它的平台上
   *    "会自动出现在这里"不是"暂时没有"，是**永远不会**。所以换一句真话。
   * ⚠️ 「放弃区」那句不用换 —— 它走的是**状态**（手动挪进去），任何平台都成立。
   */
  function emptyHintFor(st) {
    const p = PF.get(state.platform) || {};
    const caps = c => PF.supports(state.platform, c);
    const hasSrc = !!PF.sourceOf(state.platform);
    // "怎么把数据弄进来"：两句各自独立，缺哪个就少哪句
    const syncClause = hasSrc ? '点「同步」把库导进来' : '点「同步」载入游戏库';
    const addClause = p.manualAdd ? '，或点「添加」手动录入' : '';
    // 既没有数据源、又不让手动加 —— 那就别指一条走不通的路
    const nothingToDo = !hasSrc && !p.manualAdd;
    switch (st) {
      case S.PLAYING:
        return caps('lastPlayed')
          ? DS.RECENT_DAYS + ' 天内启动过的游戏会自动出现在这里，也可以手动把游戏移进来。'
          : '这个平台的资料里没有「最后启动时间」，不会有游戏自动落到这里 —— 点开卡片手动移进来。';
      case S.BACKLOG:
        return '你想玩、还没开始的游戏放这里。' + (caps('wishlist')
          ? '点「同步」会把愿望单里的游戏自动导进来。'
          : '点开卡片把状态改成「待游玩」，它就会出现在这里。');
      case S.PAUSED:
        return caps('lastPlayed')
          ? '超过 ' + DS.RECENT_DAYS + ' 天没启动的游戏会自动落到这里；也可以手动把游戏移进来。'
          : '这个平台的资料里没有「最后启动时间」，不会自动分流到这里 —— 点开卡片手动移进来。';
      case S.COMPLETED:
        return caps('achievements')
          ? '全成就、或收藏夹（默认「已完结」，可在「设置」里改）里的游戏会自动进来，也可以手动标记「已通关」。'
          : '这个平台既拿不到成就、也没有收藏夹 —— 点开卡片手动标记「已通关」。';
      case S.ABANDONED:
        return '这里是主动否掉的游戏。在「暂停区」点「批量选择」，或点开卡片改状态，都能把它挪进来。';
      default:
        return nothingToDo
          ? '这个平台暂时还没有可用的数据来源。'
          : '还没有游戏数据。' + syncClause + addClause + '。';
    }
  }

  // ===== 详情抽屉 =====
  function openDrawer(id) {
    const g = state.games.find(x => x.id === id);
    if (!g) return;
    el.drawerBody.innerHTML = drawerHtml(g);
    el.drawer.hidden = false;
    el.drawerMask.hidden = false;
    state.drawerId = id;                       // 见 state 里那条说明（后台补完要重绘）
    bindDrawer(g);
  }

  function closeDrawer() {
    el.drawer.hidden = true;
    el.drawerMask.hidden = true;
    el.drawerBody.innerHTML = '';
    state.drawerId = null;
  }

  function drawerHtml(g) {
    const m = META[g.status] || META[S.LIBRARY];
    const hours = fmtHours(g.totalMinutes);
    const recent = fmtHours(g.recentMinutes);
    const perfect = DS.isPerfect(g);
    const ach = g.achievements;

    // 状态选择器
    const statusBtns = DS.VIEW_ORDER.map(st => {
      const sm = META[st];
      const on = g.status === st ? ' on' : '';
      return '<button class="' + on.trim() + '" data-set-status="' + st + '" ' +
               'style="--sc:' + sm.color + '">' +
               '<span class="sdot"></span>' + esc(sm.label) +
             '</button>';
    }).join('');

    // 统计格
    //
    // ⚠️ 愿望单来的款（还没买）要换一组指标：它的时长和启动时间**天然是空**，
    // 照老样子渲染出来就是「总时长 — / 最后启动 —」两个灰杠，看着像数据坏了。
    // 换成它真正持有的两个信息：什么时候加的、你自己在 Steam 里排的位次。
    //
    // ⚠️ 「家人拥有」的款（家庭共享，`source='family'`）同理，而且更会误导：
    //    它的 `totalMinutes` 恒为 0（那是**我**的时长，我从没玩过）——
    //    照老样子渲染就是「总时长 — / 最后启动 —」，用户会以为数据丢了。
    //    改成说清"这是谁的、家人玩了多久"。
    const familyGame = g.source === 'family';
    const famHours = fmtHours(g.familyMinutes);
    const wishGame = g.source === 'wishlist';
    const stats = [];
    if (wishGame) {
      stats.push({ k: '加入愿望单', v: fmtDate(g.wishAddedTs) });
      if (g.wishPriority) stats.push({ k: '愿望单排序', v: '第 ' + g.wishPriority + ' 位' });
      stats.push({ k: '发售年份', v: g.releaseYear || null });
    } else if (familyGame) {
      const names = (g.familyOwners || []).map(o => o && o.name).filter(Boolean);
      stats.push({ k: '拥有者', v: names.length ? names.join('、') : '家庭成员' });
      stats.push({ k: '家人时长', v: famHours ? famHours + ' h' : null });
      stats.push({ k: '发售年份', v: g.releaseYear || null });
    } else if (!PF.supports(state.platform, 'playtime')) {
      // 🔴 平台**给不出时长**（注册表里没声明 playtime 能力）—— 照老样子渲染出来是
      //    「总时长 — / 最后启动 —」，用户会以为数据丢了。
      //    这和上面「愿望单的款」「家人拥有的款」是同一类问题：
      //    **值天然为空，而"空"在两个不同的原因下长得一模一样。**
      //    所以换一组这个平台确实持有的指标（装没装、占多大、谁做的、哪年出的）。
      if (PF.supports(state.platform, 'installed')) {
        stats.push({ k: '安装状态', v: g.installed ? '已安装' : '未安装' });
        if (g.installSize) stats.push({ k: '占用空间', v: fmtSize(g.installSize) });
      }
      if (PF.supports(state.platform, 'developer')) {
        stats.push({ k: '开发商', v: (g.developers || [])[0] || null });
      }
      stats.push({ k: '发售年份', v: g.releaseYear || null });
    } else {
      stats.push({ k: '总时长', v: hours ? hours + ' h' : null });
      stats.push({ k: '发售年份', v: g.releaseYear || null });
      stats.push({ k: '最后启动', v: fmtDate(g.lastPlayedTs) });
      if (recent) stats.push({ k: '近两周', v: recent + ' h' });
    }

    const statsHtml = stats.map(s =>
      '<div class="d-stat">' +
        '<div class="k">' + esc(s.k) + '</div>' +
        '<div class="v' + (s.v ? '' : ' dash') + '">' + (s.v ? esc(s.v) : '—') + '</div>' +
      '</div>'
    ).join('');

    // 成就
    let achHtml = '';
    if (ach && ach.total > 0) {
      const pct = Math.round(ach.earned / ach.total * 100);
      achHtml =
        '<div class="d-sec">' +
          '<h4>成就进度 <span style="color:var(--text-dim);font-weight:600">' +
            ach.earned + ' / ' + ach.total + ' · ' + pct + '%</span></h4>' +
          '<div class="d-achbar' + (perfect ? ' done' : '') + '">' +
            '<i style="width:' + pct + '%"></i>' +
          '</div>' +
        '</div>';
    }

    const perfectHtml = perfect
      ? '<div class="d-perfect">🏆 全成就达成</div>'
      : '';

    // 最后启动的相对时间
    const lastRel = relTime(g.lastPlayedTs);

    const tagsHtml = (g.genres && g.genres.length)
      ? '<div class="d-sec"><h4>类型</h4><div class="d-tags">' +
          g.genres.map(t => '<span class="d-tag">' + esc(t) + '</span>').join('') +
        '</div></div>'
      : '';

    const devHtml = (g.developers && g.developers.length)
      ? '<div class="d-sec"><h4>开发商</h4><div class="d-tags">' +
          g.developers.map(t => '<span class="d-tag">' + esc(t) + '</span>').join('') +
        '</div></div>'
      : '';

    // 玩家评价（自动抓的）—— **只有声明了 `review` 能力的平台才有这一节**。
    // 没有这一节不是"缺数据"，是那个平台本来就没有这个数据源；
    // 硬画出来会写一句"暂未抓取到 Steam 评价"，站在别的平台上等于在说别人的事。
    const reviewHtml = PF.supports(state.platform, 'review')
      ? ('<div class="d-sec">' +
          '<h4>' + esc(PF.labelOf(state.platform)) + ' 评价</h4>' +
          (g.steamReview
            ? '<div class="d-note">' + esc(g.steamReview) + '</div>'
            : '<div class="d-note placeholder">暂未抓取到评价，可在下方写自己的感想。</div>') +
        '</div>')
      : '';

    // 我的记录
    const myNoteHtml =
      '<div class="d-sec">' +
        '<h4>我的游玩记录 <button id="editNoteBtn">编辑</button></h4>' +
        (g.myNote
          ? '<div class="d-note">' + esc(g.myNote) + '</div>'
          : '<div class="d-note placeholder">还没写。点「编辑」记下打到哪了、喜欢什么、哪里劝退。</div>') +
      '</div>';

    // 去商店看看：地址**按这条记录的归属平台**从注册表取（`storeUrl` 声明）。
    // 拼不出来就不画 —— 以前这里写死的是某一个平台的 URL，拿别的平台的记录去点它，
    // 打开的是一个真实存在、但**不是这一款**的页面（比 404 更难发现）。
    const gPlat = PF.of(g);
    const storeUrl = PF.storeUrlOf(gPlat, g);
    const storeLink = storeUrl
      ? '<a class="d-link" href="' + esc(storeUrl) + '" target="_blank" rel="noopener">' +
        '🔗 在 ' + esc(PF.labelOf(gPlat)) + ' 商店查看</a>'
      : '';

    const autoTag = g.statusLocked
      ? '<span class="autoflag locked">🔒 已锁定</span>'
      : (g.manualStatus
          ? '<span class="autoflag manual">手动设定</span>'
          : (g.autoStatus
              ? '<span class="autoflag auto">按启动日期自动</span>'
              : (g.source === 'steam' ? '<span class="autoflag">Steam 自动</span>'
                 : (g.source === 'wishlist' ? '<span class="autoflag">来自 Steam 愿望单</span>'
                    : ''))));

    // 锁定开关：锁住后完全不参与自动归类
    const lockHtml =
      '<button class="lockbtn' + (g.statusLocked ? ' on' : '') + '" id="lockBtn" ' +
        'title="锁定后，同步时状态不会被自动归类改动">' +
        (g.statusLocked ? '🔒 状态已锁定' : '🔓 锁定状态') +
      '</button>';

    // 自动归类的解释行
    let autoExplain = '';
    if (g.statusLocked) {
      autoExplain = '状态已锁定，同步时不会参与自动归类（「已通关」也不重算）。';
    } else if (g.status === S.ABANDONED) {
      autoExplain = '已放弃：这是手动终态，同步时不会被启动日期或收藏夹改动。' +
                    '想重新捡起来，点上面的状态按钮挪走即可。';
    } else if (DS.isStale(g)) {
      autoExplain = '距上次启动已 ' + Math.floor(DS.daysSincePlayed(g)) +
                    ' 天 —— 如果确定不会再玩了，可以把它移入「放弃区」。';
    } else if (g.autoStatus) {
      const d = DS.daysSincePlayed(g);
      if (d >= 0) {
        const dd = Math.floor(d);
        autoExplain = g.status === S.PAUSED
          ? '距上次启动已 ' + dd + ' 天（超过 ' + DS.RECENT_DAYS + ' 天）→ 自动归入「暂停区」。'
          : '距上次启动 ' + dd + ' 天（在 ' + DS.RECENT_DAYS + ' 天内）→ 自动归入「正在游玩」。';
      }
    }

    return '' +
      '<div class="d-hero">' +
        (g.header
          ? '<img src="' + esc(g.header) + '" alt="" onload="GVCoverFit.apply(this)">'
          : '') +
        '<div class="d-hero-title"><h2>' + esc(g.title) + '</h2></div>' +
      '</div>' +
      '<div class="d-body">' +
        '<div class="d-statusrow">' +
          '<div class="statuspick">' + statusBtns + '</div>' +
          autoTag +
        '</div>' +
        (autoExplain ? '<div class="d-autoexplain">' + esc(autoExplain) + '</div>' : '') +
        '<div class="d-lockrow">' + lockHtml + '</div>' +
        perfectHtml +
        '<div class="d-stats">' + statsHtml + '</div>' +
        (lastRel ? '<div style="font-size:12px;color:var(--text-faint);margin:-9px 0 15px">最后启动：' +
                   esc(lastRel) + '</div>' : '') +
        achHtml +
        myNoteHtml +
        reviewHtml +
        devHtml +
        tagsHtml +
        '<div class="d-actions">' +
          storeLink +
          '<button class="btn btn-danger" id="deleteBtn">删除</button>' +
        '</div>' +
      '</div>';
  }

  function bindDrawer(g) {
    // 状态切换
    el.drawerBody.querySelectorAll('[data-set-status]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const st = btn.dataset.setStatus;
        g.status = st;
        g.manualStatus = st;            // 记下手动设定的状态
        // 记下手动时间：只要它晚于「上次启动时间」，同步时就保留手动结果
        //（用户手动改完又启动过 -> lastPlayedTs 更新 -> 自动归类重新接管）
        g.statusManualAt = Math.floor(Date.now() / 1000);
        g.autoStatus = false;           // 手动设定后就不再是"自动归类"的产物
        // 若它本来靠收藏夹（默认「已完结」）自动进了已通关，而用户手动挪走，
        // 记下迟滞标记：之后同步不再把它拉回已通关（除非 Steam 里移出该分类再重新加入）
        if (st !== DS.STATUS.COMPLETED && DS.inCompletedCollection(g)) {
          g.dismissedCollection = true;
        } else if (st === DS.STATUS.COMPLETED) {
          g.dismissedCollection = false;
        }
        g.updatedAt = Date.now();
        await DS.save(g);
        await reload();
        openDrawer(g.id);               // 重绘抽屉
      });
    });

    // 锁定开关：锁住后同步不再改动状态
    const lockBtn = el.drawerBody.querySelector('#lockBtn');
    if (lockBtn) {
      lockBtn.addEventListener('click', async () => {
        g.statusLocked = !g.statusLocked;
        g.updatedAt = Date.now();
        await DS.save(g);
        await reload();
        openDrawer(g.id);
      });
    }

    // 编辑记录
    const editBtn = el.drawerBody.querySelector('#editNoteBtn');
    if (editBtn) {
      editBtn.addEventListener('click', () => openNoteEditor(g));
    }

    // 删除
    const delBtn = el.drawerBody.querySelector('#deleteBtn');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm('确定要删除「' + g.title + '」吗？此操作不可撤销。')) return;
        await DS.remove(g.id);
        closeDrawer();
        await reload();
      });
    }
  }

  // ===== 我的记录编辑器 =====
  function openNoteEditor(g) {
    state.noteTargetId = g.id;
    el.noteGameName.textContent = g.title;
    el.noteText.value = g.myNote || '';
    el.noteMask.hidden = false;
    setTimeout(() => el.noteText.focus(), 50);
  }

  function closeNoteEditor() {
    el.noteMask.hidden = true;
    state.noteTargetId = null;
  }

  async function saveNote() {
    const g = state.games.find(x => x.id === state.noteTargetId);
    if (!g) return closeNoteEditor();
    g.myNote = el.noteText.value.trim();
    g.updatedAt = Date.now();
    await DS.save(g);
    closeNoteEditor();
    await reload();
    openDrawer(g.id);
  }

  // ===== 手动添加 =====
  function openAddModal() {
    el.mTitle.value = '';
    el.mAppid.value = '';
    el.mNote.value = '';
    el.mStatus.innerHTML = DS.VIEW_ORDER.map(st =>
      '<option value="' + st + '">' + META[st].icon + ' ' + META[st].label + '</option>'
    ).join('');
    el.mStatus.value = S.BACKLOG;
    closeSuggest();          // 清掉上一次留下的候选，别让第二次打开看到旧列表
    el.modalMask.hidden = false;
    setTimeout(() => el.mTitle.focus(), 50);
  }

  function closeAddModal() {
    closeSuggest();
    el.modalMask.hidden = true;
  }

  async function saveNewGame() {
    const title = el.mTitle.value.trim();
    if (!title) { el.mTitle.focus(); return; }

    const appidRaw = el.mAppid.value.trim();
    const status = el.mStatus.value || S.BACKLOG;

    let appid = null, icon = '', header = '';
    if (/^\d+$/.test(appidRaw)) {
      appid = Number(appidRaw);
      icon = 'https://media.steampowered.com/steamcommunity/public/images/apps/' + appid + '/';
      header = 'https://cdn.cloudflare.steamstatic.com/steam/apps/' + appid + '/header.jpg';
      // 尝试从本地缓存里补全
      const known = state.games.find(x => String(x.appid) === String(appid));
      if (known) { icon = known.icon || icon; header = known.header || header; }
    }

    const g = DS.makeGame({
      appid: appid,
      title: title,
      icon: icon,
      header: header,
      // 发售年份不再让用户手填（2026-09-18 反馈：这项没用）。
      // 手工游戏先留空；填了 AppID 的话，保存后由商店信息补上
      // （`fillMetaInBackground` 那一步，按 release_year 写回来）。
      status: status,
      manualStatus: status,
      myNote: el.mNote.value.trim(),
      source: 'manual'
    });

    await DS.save(g);
    closeAddModal();
    await reload();

    // 跳到该游戏所在区块，方便确认
    state.view = status;
    render();
    openDrawer(g.id);

    // 🔴 填了 AppID 就**立刻问一次商店**，把类型 / 开发商 / 发售年补上。
    //
    //    「名字和封面」在保存那一刻就已经有了（名字是候选给的、封面是按 appid
    //    拼的 URL），可**这三项只有真问过商店才有** —— 而补资料那条守卫是
    //    「名字和封面都有就跳过」，对手动条目恰好成立，于是它会被一路跳过、
    //    这几项永远空着。所以这里既开守卫的口子（local-src.js 的 `manualGap`），
    //    也在保存后主动推一把，让它**不用等到下次同步**。
    //
    //    ⚠️ 只补这一款（`[appid], 1`），不碰整个库。
    //    ⚠️ **故意不 await**：外网快慢不该让「添加」这个动作卡住。
    //       补完由 `fillMetaInBackground` 自己重绘，连开着的这张详情一起。
    //    ⚠️ 条件用 `state.desktop` **不是** `desktopMode` —— 后者是 boot() 里的
    //       局部变量，这里取不到（写成它会直接 ReferenceError）。
    //       `state.desktop` 为假时（双击 index.html 那个纯本地版）没有后端可问，
    //       直接不发，省掉一次注定失败、还会被当成"没答上来"的请求。
    if (state.desktop && appid != null) fillMetaInBackground([appid], 1);
  }

  // ===== 手动添加 · 按名字搜 Steam 商店 =====
  //
  // 用户要的：输了名字，先知道 Steam 上有没有这款、是哪一个，选中就把
  // AppID 填上。拿到 appid 之后，**封面 / 类型 / 开发商 / 发售年**这些交给
  // 既有的补全链路去问（见 saveNewGame 末尾那次触发）—— 所以候选只要有
  // 名字和 appid 就够，不用在这里再查一遍。
  // ⚠️ 别把这句话读成「保存后什么都不用做」：补资料那条守卫只放行
  //    「名字或封面有缺」的款，手动条目两样都有 → 得靠 `manualGap` 那个
  //    例外 + saveNewGame 末尾的主动触发，两者缺一，这几项就永远是空的。
  //    （2026-09-28：早先这里的注释写成「保存后自动补」，是错的 —— 当时
  //    saveNewGame 根本没调补全。留个记号，免得再想当然。）
  //
  // 🔴 三条不能破的约定：
  //   ① **只补公共元数据，绝不改变「拥有」语义。**
  //      搜到 ≠ 你有这款。这段代码不写任何存储，只把 appid 填进表单；
  //      真正落库还是走 saveNewGame，那边一律 source='manual'。
  //   ② **不搜也能正常添加。** 联想是加速，不是必经步骤 —— 断网、搜不到、
  //      或者用户就是想自己打名字，都必须照旧能加。
  //   ③ **手填 AppID 那条路保留**（用户可能本来就知道自己要哪款）。
  //
  // ⚠️ 它只在**有后端**时出现（桌面版 / 线上版）。双击 index.html 那个纯本地版
  //    拿不到 —— 浏览器不允许网页直接问 Steam（CORS），这条是硬约束不是省事。
  //    所以没后端时整段安静地不工作，也不弹任何「搜不了」的提示：
  //    用户只是想记一款游戏，不该被技术原因打扰。

  const SG_DEBOUNCE = 400;   // 停手多久才去搜。太短会在打字过程中打出一串请求
  const SG_MIN_LEN = 2;      // 少于这么多字不搜：一个字的结果太泛，纯属浪费请求

  /** 现在有没有「能搜商店」的后端？没有就整段联想安静地不工作。 */
  function suggestBackend() {
    // 🔓 自动化验收留的注入位（**产品代码从不设它**）。
    //    不这么做的话，「有后端」这条路径在 file:// 测试页里**永远走不到** ——
    //    那里 probe 一定失败 → state.desktop 恒为 false → 防抖 / 渲染 / 回填
    //    整条链零覆盖。而这条链正是这次功能的核心，零覆盖比多这两行危险得多。
    //    （XSS 意义上也是安全的：这是页面自己的全局，能被设就说明页面早已被接管。）
    if (window.__gvSuggestBackend) return window.__gvSuggestBackend;
    if (state.desktop && window.GVLocal && window.GVLocal.searchApps) return window.GVLocal;
    return null;
  }

  function suggestOpen() {
    return !!(el.mSuggest && !el.mSuggest.hidden);
  }

  function closeSuggest() {
    sgSeq++;                 // 让还在飞的那次响应作废（回来了也别再画）
    sgItems = [];
    sgIndex = -1;
    sgTerm = '';
    if (el.mSuggest) {
      el.mSuggest.hidden = true;
      el.mSuggest.innerHTML = '';
    }
  }

  /**
   * 只放一句提示（「没找到」/「这次没连上」），不渲染成列表。
   * `isErr` 区分两者 —— 前者是正常结果，后者是故障，颜色上要分得开。
   */
  function suggestHint(text, isErr) {
    if (!el.mSuggest) return;
    sgItems = [];
    sgIndex = -1;
    el.mSuggest.innerHTML =
      '<div class="sg-hint' + (isErr ? ' err' : '') + '">' + esc(text) + '</div>';
    el.mSuggest.hidden = false;
  }

  function renderSuggest(list, term) {
    // 「已在游戏单」标注 —— 光看名字用户不一定想得起来自己记过没有，
    // 重复添加一款会让库里出现两张一模一样的卡。这里只**标注**，不做任何拦截：
    // 用户要是真想再记一条（比如换个状态分类），那是他的自由。
    const inLib = {};
    state.games.forEach(g => { if (g.appid != null) inLib[String(g.appid)] = 1; });

    sgItems = list;
    sgIndex = -1;
    sgTerm = term;
    el.mSuggest.innerHTML = list.map((it, i) =>
      '<div class="sg-item" data-i="' + i + '" role="option">' +
        (it.tiny
          ? '<img class="sg-thumb" src="' + esc(it.tiny) + '" alt="" loading="lazy">'
          : '<span class="sg-thumb"></span>') +
        '<span class="sg-name" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' +
        (inLib[String(it.appid)] ? '<span class="sg-own">已在游戏单</span>' : '') +
      '</div>').join('');
    el.mSuggest.hidden = false;
  }

  function suggestHighlight(i) {
    if (!el.mSuggest || !sgItems.length) return;
    // 环形选择：末项再往下回到首项（只有几条候选时这点很顺手）
    sgIndex = ((i % sgItems.length) + sgItems.length) % sgItems.length;
    const nodes = el.mSuggest.querySelectorAll('.sg-item');
    nodes.forEach((n, k) => n.classList.toggle('on', k === sgIndex));
    if (nodes[sgIndex] && nodes[sgIndex].scrollIntoView) {
      nodes[sgIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * 选中第 i 个候选 → 回填「名称 + AppID」。
   *
   * ⚠️ **只动这两个字段**，不碰用户已经写好的备注和状态 ——
   *    用户很可能先写了感想、才回头把名字改准，覆盖掉会很恼人。
   */
  function pickSuggest(i) {
    const it = sgItems[i];
    if (!it) return;
    el.mTitle.value = it.name;
    el.mAppid.value = String(it.appid);
    closeSuggest();
    el.mTitle.focus();
  }

  async function doSuggest(term) {
    const be = suggestBackend();
    if (!be) return;
    const my = ++sgSeq;                   // 认领这次请求
    let r = null;
    try { r = await be.searchApps(term); } catch (e) { r = null; }

    // 🔴 只认最新一次：用户手快时会有多个请求同时在飞，先发的后到就会把
    //    「只狼」的候选画到「只狼 2」的输入框下面。序号是唯一的防线。
    if (my !== sgSeq) return;
    // 输入框已经不在这句话上了（用户删了字 / 又改了）→ 别画
    if (el.mTitle.value.trim() !== term) return;

    if (!r || !r.ok) {
      // 「输入被清空」是正常的收摊，不是错误
      if (r && r.reason === 'empty') { closeSuggest(); return; }
      // 🔴 「没搜成」和「没搜到」必须说成两件事（理由见 local-src.js 的同名函数）。
      //    说成「没找到」，用户会以为是自己名字打错了，然后一直改字。
      const why = (r && r.message) ? r.message : '';
      if (r && r.reason === 'steam_unreachable') {
        suggestHint('这次没连上 Steam 商店（跨境链路波动），稍等几秒再输一次就行。', true);
      } else if (r && r.reason === 'fetch_failed') {
        suggestHint('连不上本机服务，搜索暂时用不了（不影响手动填写）。', true);
      } else {
        suggestHint(why || '搜索暂时用不了（不影响手动填写）。', true);
      }
      return;
    }

    if (!r.items || !r.items.length) {
      // 这是**正常结果**：确实没这款。用中性色，并可执行地指回手动填写。
      suggestHint('Steam 商店里没找到这个名字的正式游戏 —— 可以直接手动填写。', false);
      return;
    }
    renderSuggest(r.items, term);
  }

  /** 名字输入框变了 → 防抖后去搜 */
  function onTitleInput() {
    const term = el.mTitle.value.trim();
    clearTimeout(sgTimer);
    if (!suggestBackend()) return;                  // 没有后端就完全不打扰
    if (term.length < SG_MIN_LEN) { closeSuggest(); return; }
    if (term === sgTerm && sgItems.length) return;  // 同一个词、候选还在 → 不重复问
    sgTimer = setTimeout(() => doSuggest(term), SG_DEBOUNCE);
  }

  function onTitleKeydown(e) {
    if (e.key === 'Escape') {
      if (suggestOpen()) { e.preventDefault(); closeSuggest(); }
      else closeAddModal();
      return;
    }
    // 没候选时，回车保持原语义（= 保存）
    if (!sgItems.length || !suggestOpen()) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); saveNewGame(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); suggestHighlight(sgIndex + 1); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); suggestHighlight(sgIndex - 1); return; }
    if (e.key === 'Enter') {
      // ⚠️ 输入法组字期间的回车是「上屏」，不是「确认」。少了这一句，
      //    中文用户打完字按回车选词，会当场把表单保存掉。
      if (e.isComposing) return;
      e.preventDefault();
      // 有高亮 → 选它；没高亮 → 还是保存（用户可能就是想直接加）
      if (sgIndex >= 0) pickSuggest(sgIndex); else saveNewGame();
    }
  }

  function onSuggestClick(e) {
    const node = e.target && e.target.closest ? e.target.closest('.sg-item') : null;
    if (!node) return;
    const i = Number(node.getAttribute('data-i'));
    if (!isNaN(i)) pickSuggest(i);
  }

  // ===== Steam 同步 =====
  /**
   * 打开同步面板。**两条完全不同的路，按模式分**：
   *
   *   · 桌面版 —— 应用的本机进程**本来就能读盘**，所以主路径是"直接同步"。
   *     「先去项目目录跑 scripts/sync.py、再回来选 JSON」那套是给**浏览器**用的
   *     （浏览器读不到盘），搬到桌面版来纯属多此一举 —— 面板打开即自动同步一次。
   *   · 其它（线上版 / 双击 index.html）—— 只能选文件，行为不变。
   *
   * 桌面版**保留**文件入口：那是「设置 → 数据备份」里导出的文件的导入端，
   * 换机器时要靠它。
   */
  function openSyncModal() {
    el.syncFile.value = '';
    state.syncPayload = null;
    el.syncApply.disabled = true;
    el.syncDiff.innerHTML = '';

    if (state.desktop) {
      el.syncLocalSec.hidden = false;
      el.syncApply.hidden = true;      // 桌面版同步即刻生效，没有"待应用"这一步
      // 文件入口在桌面版是「导入备份」用的 —— 标签上也别再说"由 scripts/sync 生成"，
      // 那会让用户以为还得先去项目目录跑一次脚本（正是这次要消掉的那一步）。
      el.syncFileEm.textContent = '（换机器时导入用）';
      el.syncFileHint.innerHTML =
        '换机器时用它导入以前备份的 JSON —— 导出入口在「设置 → 数据备份」。';
      setSyncStatus('正在读取本机 Steam…', '');
      el.syncMask.hidden = false;
      syncDesktop();                   // 故意不 await：面板先显示出来，别让点击看起来没反应
      return;
    }

    el.syncLocalSec.hidden = true;
    el.syncApply.hidden = false;
    el.syncFileEm.textContent = '（由 scripts/sync 生成）';
    el.syncFileHint.innerHTML =
      '在项目目录运行 <code>python scripts/sync.py</code>，会生成 ' +
      '<code>data/steam_sync.json</code>，然后在这里选它载入。';
    setSyncStatus('选择一个由 scripts/sync 生成的 JSON 文件。', '');
    el.syncMask.hidden = false;
  }

  function closeSyncModal() { el.syncMask.hidden = true; }

  function setSyncStatus(text, cls) {
    el.syncStatus.className = 'sync-status' + (cls ? ' ' + cls : '');
    el.syncStatus.textContent = text;
  }

  let syncBusy = false;

  /** 本机同步失败时，把 reason 翻成能指导下一步动作的话 */
  function localFailText(r) {
    return {
      steam_not_found: '没找到 Steam 安装目录 —— 去「设置」里指定，或点「扫描磁盘」找一下',
      no_account: '读不到已登录的 Steam 账号 —— 请先在本机登录一次 Steam',
      fetch_failed: '读本机数据失败（本机服务没有响应）',
      no_datastore: '本地存储没准备好'
    }[(r && r.reason)] || ('读取本机 Steam 数据失败（' + ((r && r.reason) || '原因不明') + '）');
  }

  /** 联网同步失败时同理 */
  function onlineFailText(reason) {
    return {
      profile_private: 'Steam 的「游戏详情」没有设为公开，读不到你的库',
      // ⚠️ 这条和 steam_unreachable 是**解法完全相反**的两种失败：
      //    上面那条等一会儿就好，这条**重试到天亮也不会好** ——
      //    所以必须明说"去换 Key"，否则用户会一直点同步、一直失败。
      steam_key_rejected: 'Steam 拒绝了这个 API Key（失效或填错了）—— 去「设置」里换一把，重试没有用',
      steam_unreachable: '连不上 Steam（跨境链路抖动），过几秒再点一次「同步」通常就好了',
      no_key: '还没有填 Steam Web API Key',
      no_steamid: '还没有绑定 SteamID',
      fetch_failed: '本机服务没有响应',
      empty: 'Steam 返回的游戏库是空的'
    }[reason] || ('联网同步失败（' + (reason || '原因不明') + '）');
  }

  /**
   * 愿望单那一行的失败文案。
   *
   * ⚠️ 这里只兜「服务端没说清」的兜底情况 —— 服务端给了 `message` 就**优先用它**
   *    （它知道究竟是没 Key、Key 被拒、还是资料没公开）。所以下面的 key 与
   *    `local-src.js` 里 `syncWishlist` 的 `reason` 一一对应，
   *    别在这儿改成另一套词，否则同一件事会有两种说法。
   */
  function wishFailText(reason) {
    return {
      // 「空」和「没公开」Steam 返回的是同一份数据，分不开 —— 别把话说死
      // ⚠️ 这里是**纯文本**（会过 esc() 塞进 <b> 里），写 Markdown 的 `**` 只会被原样显示
      unavailable: '愿望单没读到（可能是空的，也可能是没公开）',
      empty: '愿望单这次返回的是空的，已跳过（不做任何删除）',
      // 和 onlineFailText 同一个道理：Key 失效不会自己好，重试没有出口
      steam_key_rejected: 'Steam 拒绝了这个 API Key —— 去「设置」里换一把，重试没有用',
      steam_unreachable: '连不上 Steam（跨境链路抖动），过几秒再点一次「同步」通常就好了',
      no_key: '还没有填 Steam Web API Key',
      fetch_failed: '本机服务没有响应',
      no_steamid: '还没有绑定 SteamID',
      bad_response: '服务端回了个看不懂的响应'
    }[reason] || ('愿望单没读到（' + (reason || '原因不明') + '）');
  }

  /**
   * 成就那一行的失败文案。
   *
   * ⚠️ 同 `wishFailText`：只兜「服务端没说清」的情况 —— 服务端给了 `message`
   *    就**优先用它**。下面的 key 与 `local-src.js` 里 `syncAchievements` 的
   *    `reason` 一一对应，别改成另一套词。
   *
   * 🔴 「这次一款都没问到」与「这些游戏都没成就」是**两件事** ——
   *    前者是链路问题（下次接着来），后者是确定性答案（已落库 `{0,0}`）。
   *    文案必须分开，否则用户会把"没连上"读成"我的游戏都没成就"。
   */
  function achFailText(reason) {
    return {
      steam_unreachable: '这次没连上 Steam（跨境链路抖动），过几秒再点一次「同步」就会接着核',
      steam_key_rejected: 'Steam 拒绝了这个 API Key —— 去「设置」里换一把，重试没有用',
      no_key: '还没有填 Steam Web API Key',
      no_steamid: '还没有绑定 SteamID',
      profile_private: 'Steam 的「游戏详情」没有设为公开',
      fetch_failed: '本机服务没有响应',
      bad_response: '服务端回了个看不懂的响应'
    }[reason] || ('成就这次没核成（' + (reason || '原因不明') + '）');
  }

  // 「去申请 API Key」的官方地址。写成常量：同步面板和账号设置两处都要用，
  // 散着写迟早有一处改漏。
  // ⚠️ 必须 `target="_blank"`：桌面窗口里点它，pywebview 会把这次新窗口请求
  //    交给**系统浏览器**（`OPEN_EXTERNAL_LINKS_IN_BROWSER` 默认为真，
  //    见 webview/__init__.py 的 settings 与 edgechromium.py 的 on_new_window_request）。
  //    所以不需要为此单开一个「用系统浏览器打开某 URL」的服务端接口。
  const STEAM_KEY_URL = 'https://steamcommunity.com/dev/apikey';

  /**
   * 这次同步会走哪条路 —— **单一判据**。
   *
   * 🔴 渲染文案、执行流程、失败归因都读它，别各判各的。
   *    以前就是"前端自己判有没有 Key"→ 判成"没有"以后**连请求都不发**，
   *    于是服务端那段早就写好的「怎么修」文案永远到不了用户眼前，
   *    用户看到的只是一行不起眼的小字（实测投诉：绑了账号点同步，还是只有本机数据）。
   */
  function syncPlan() {
    const st = desktopStatus || {};
    const auto = st.autoAccount || {};
    const sid = String(st.steamId || '').trim() || String(auto.steamId || '').trim();
    return {
      st: st,
      auto: auto,
      sid: sid,
      viaAuto: !st.steamId && !!sid,                       // 用的是本机检测到的账号
      hasKey: !!(st.hasApiKey || st.hasEnvKey)
    };
  }

  /** 面板里的"现在会拿什么去同步"两行 —— 让用户在点之前就知道结果从哪来 */
  function renderSyncLocalInfo() {
    const p = syncPlan();
    const st = p.st;
    const bits = [];
    bits.push('本机目录：' + (st.steamDir || '未找到'));
    if (p.sid) {
      const who = p.viaAuto ? '本机检测到' : '已绑定';
      bits.push(who + '账号：' + p.sid + (p.auto.accountName ? '（' + p.auto.accountName + '）' : ''));
    } else {
      bits.push('未绑定 Steam 账号（只同步本机数据）');
    }
    bits.push(p.hasKey ? 'API Key：已配置' : 'API Key：未配置');
    el.syncLocalInfo.className = 'set-status';
    el.syncLocalInfo.textContent = bits.join('　·　');

    renderSyncSourceNote(p);
  }

  /**
   * 「本次数据来源」结论行。
   *
   * 为什么要单独一行、还要带申请链接：本机 Steam 文件**结构上只有**
   * 「装过 / 玩过 / 在收藏夹里」的款（本机约 300 款 / 账号侧约 400 款），而全量库必须联网
   * （Steam 的库接口强制要 API Key，没有免 key 的路子）。
   * 所以"要不要联网"不是可选项，是"数据全不全"的分水岭 ——
   * 必须写在用户点按钮之前，而不是同步完在结果里悄声提一句。
   */
  function renderSyncSourceNote(p) {
    if (!el.syncSourceNote) return;
    if (p.sid && p.hasKey) {
      el.syncSourceNote.className = 'set-status is-ok';
      el.syncSourceNote.innerHTML =
        '数据来源：<b>联网全量库（主）</b>　+　本机补充（收藏夹 / 本地封面 / 联网列不到的款）';
    } else if (p.sid) {
      el.syncSourceNote.className = 'set-status is-warn';
      el.syncSourceNote.innerHTML =
        '数据来源：<b>只有本机</b> —— 联网取全量库需要 API Key（' +
        '<a href="' + STEAM_KEY_URL + '" target="_blank" rel="noopener">去申请</a>，免费）。' +
        '本机只有「装过 / 玩过 / 在收藏夹里」的款，买了没碰过的看不到。';
    } else {
      el.syncSourceNote.className = 'set-status is-warn';
      el.syncSourceNote.innerHTML =
        '数据来源：<b>只有本机</b> —— 还没绑定 Steam 账号，拿不到「买了但从没碰过」的那些。' +
        '去「账号设置」绑一下就能联网取全量。';
    }
  }

  // ============================================================
  // 家庭库（Steam Families）—— 桌面版专有
  // ============================================================
  //
  // 🔑 **为什么只有桌面版能做**：家庭组的**成员名单**存在本机 Steam 文件里
  //    （`userdata/<accountid>/config/localconfig.vdf` 的 `FamilyGroup` 块），
  //    而 Steam 的 Web API **没有任何家庭接口** ——
  //    `ISteamWebAPIUtil/GetSupportedAPIList` 拉全量清单 54 个接口，一个都不沾边；
  //    连"家里有谁"都得靠本机文件。名单到手之后，才对每个成员调 `GetOwnedGames`
  //    取并集（它对**任何** steamid 都有效，只要对方把「游戏详情」设为公开）。
  //
  // ⚠️ 这份并集是**上界**，不是"你能玩的清单"：Steam Families 有不可共享的项
  //    （发行商关闭共享 / 需要第三方 key / 被 VAC 封禁）。所以文案一律说
  //    "**家人拥有**这些"，绝不说"你能玩这些"。
  let familyInfo = null;   // {state:'loading'|'ok'|'none'|'err', group, members, reason}

  /** 读一次家庭组并刷新面板那行。**没有家庭组是完全正常的状态**，不是错误。 */
  async function refreshFamilyInfo() {
    if (!state.desktop || !window.GVLocal || !window.GVLocal.loadFamily) return;
    familyInfo = { state: 'loading' };
    renderSyncFamilyNote();
    let f = null;
    try { f = await window.GVLocal.loadFamily(); } catch (e) { f = null; }
    if (!f) {
      familyInfo = { state: 'err', reason: '本机服务没有响应' };
    } else if (!f.ok) {
      familyInfo = { state: 'none', reason: f.hint || '' };
    } else {
      familyInfo = { state: 'ok', group: f.group || {}, members: f.members || [] };
    }
    renderSyncFamilyNote();
  }

  function renderSyncFamilyNote() {
    if (!el.syncFamilyNote) return;
    if (!state.desktop) { el.syncFamilyNote.hidden = true; return; }
    el.syncFamilyNote.hidden = false;
    const f = familyInfo;
    if (!f || f.state === 'loading') {
      el.syncFamilyNote.className = 'set-status';
      el.syncFamilyNote.textContent = '家庭库：正在读本机的家庭组…';
      return;
    }
    if (f.state === 'err') {
      el.syncFamilyNote.className = 'set-status is-warn';
      el.syncFamilyNote.textContent = '家庭库：' + f.reason;
      return;
    }
    if (f.state === 'none') {
      el.syncFamilyNote.className = 'set-status';
      el.syncFamilyNote.textContent = '家庭库：这个账号没有加入 Steam 家庭组';
      return;
    }
    const others = f.members.filter(m => m && !m.isMe);
    const gn = f.group.name ? '「' + f.group.name + '」' : '';
    if (!others.length) {
      el.syncFamilyNote.className = 'set-status';
      el.syncFamilyNote.textContent = '家庭库：家庭组' + gn + '里只有你自己';
      return;
    }
    el.syncFamilyNote.className = 'set-status is-ok';
    el.syncFamilyNote.innerHTML =
      '家庭库：家庭组' + esc(gn) + '共 <b>' + f.members.length + ' 人</b>（含你）—— ' +
      '同步时会把<b>其他 ' + others.length + ' 人公开的库</b>读进来、标成「家人拥有」。' +
      '⚠️ 那是<b>他们拥有</b>的款，不等于你都能玩（Steam 有些游戏不允许家庭共享）。';
  }

  /** 某个家庭成员没读到时，那句解释（服务端给了 message 就用它的） */
  function familyMissText(reason) {
    return {
      profile_private: '他的「游戏详情」没有设为公开，读不到他的库',
      no_key: '缺 API Key（读别人的库也要 key）',
      steam_key_rejected: 'API Key 被 Steam 拒绝 —— 换一把，重试没有用',
      steam_unreachable: '连不上 Steam（跨境链路抖动）',
      fetch_failed: '本机服务没有响应',
      bad_response: '返回内容看不懂',
      budget: '这次同步时间用完了，还没轮到这一位',
      empty: '他的库是空的 —— 也可能只是「游戏详情」没公开',
      no_family: '没有加入 Steam 家庭组',
      no_members: '家庭组里只有你自己'
    }[reason] || ('没读到（' + (reason || '原因不明') + '）');
  }

  /**
   * 桌面版同步：**先本机、再联网**。
   *
   * 🔴 顺序不能反：联网那一步拿不到收藏夹（Steam 库接口只回游戏/时长/图标），
   *    而 `mergeSteam` 对 `collections` 是"有数组就无条件覆盖" ——
   *    收藏夹只能由**本机那次**写。`GVLocal.syncOnline` 里更是干脆不带这个字段。
   *
   * 联网是**可选**的：没绑账号 / 没填 Key 就只做本机那半 ——
   * 不报错、不算失败，只是少一批"买了但没碰过"的。
   */
  async function syncDesktop() {
    if (syncBusy) return;                 // 面板能连点，别叠起来跑
    syncBusy = true;
    el.syncLocalBtn.disabled = true;
    renderSyncLocalInfo();

    const rows = [];
    let localOk = false;
    let localBad = '';
    let newIds = [];
    let onlineBad = '';
    let onlineOk = false;
    let onlineTotal = 0;
    // 家庭库那半（桌面版专有）—— 与 ①② 完全独立：它读的是**别人**的库
    let familyOk = false;
    let familyBad = '';
    let familyTotal = 0;
    let familyAdded = 0;
    let familyMissing = [];
    let plan = null;      // 收尾文案要知道"账号到底绑了没"（p 只在 try 块里活着）
    // 🔴 ②.5 愿望单 / ②.75 成就 的这几个变量**必须声明在这里**（不能在 try 块里）。
    //    它们要在 `try/finally` **之后**的收尾文案里读 —— 而 `let` 是块作用域的，
    //    写在 try 体内，跳出那个块之后就是 `ReferenceError`。
    //    ⚠️ 实测过这条：原先只有 `wish*` 这一组漏在了 try 里，于是只要
    //    「进了收尾分支」（本机那半读成功就会进，本机装了 Steam 的机器基本必然），
    //    函数就停在 `if (wishOk)` 那一行抛异常 —— 而它是 async 且没有调用方 catch，
    //    异常被静默吞掉。表现是**明细行全对、状态行永远停在最后一个中间态、
    //    界面不刷新**（愿望单其实已经写进库了，只是没重绘）。
    //    `family*` 当初就声明在外面（见上面那行注释），`wish*` 漏了 —— 这次一并补齐。
    let wishOk = false, wishReason = '', wishBad = '', wishCount = 0, wishAdded = 0;
    let wishIds = [];
    let achOk = false, achBad = '', achReason = '';
    let achAsked = 0, achGot = 0, achLeft = 0, achRecollected = 0, achSkipped = false;

    try {
      // ---- ① 本机（永远做）----
      setSyncStatus('正在读取本机 Steam…', '');
      let r = null;
      try { r = await window.GVLocal.sync(); } catch (e) { r = null; }
      if (r && r.ok) {
        localOk = true;
        const st = r.stats || {};
        rows.push(['本机 Steam', (r.total || 0) + ' 款（辅助：收藏夹 / 本地封面 / 联网列不到的款）']);
        rows.push(['已安装 / 有名字 / 有封面 / 有时长',
          (st.installed || 0) + ' / ' + (st.named || 0) + ' / ' +
          (st.withCover || 0) + ' / ' + (st.played || 0)]);
        rows.push(['新增 / 更新', (r.added || 0) + ' / ' + (r.updated || 0)]);
        if (r.recollected) rows.push(['被收藏夹拉回「已通关」', r.recollected + ' 款']);
        setSyncStatus('本机数据已同步。', 'ok');
      } else {
        localBad = localFailText(r);
        setSyncStatus(localBad, 'err');
      }

      // ---- ② 联网 ----
      //
      // 🔴 这里**不再自己判断「有没有 Key」**。
      //    以前是 `if (!hasApiKey && !hasEnvKey) rows.push('未填 API Key —— …')` ——
      //    于是缺 Key 时**一个请求都不发**，服务端那段「为什么读不到 + 怎么修」的
      //    文案（`howToFix`，带申请地址）永远到不了用户眼前。
      //    现在一律发出去，让**服务端**回答"行不行、为什么不行" ——
      //    它才是唯一知道 `.env` / 用户填的 key / profile 公不公开的那一端。
      //    代价只是缺 Key 时多一次本机回环请求（不碰外网），换来确定性的归因。
      //
      // 🔴 也不再要求「本机必须读成功」。联网取全量库**完全不需要本机 Steam**
      //    —— 而那恰恰是这台机器上最容易缺的东西（换了台电脑、新装的系统、
      //    Steam 装在别的盘没被认出来）。以前本机一失败就整块跳过联网，
      //    于是"联网为主"在最需要它的场景里反而用不上。现在两半各报各的。
      const p = syncPlan();
      plan = p;

      if (p.sid) {
        setSyncStatus('正在问 Steam 要全量库…', '');
        let o = null;
        try { o = await window.GVLocal.syncOnline(p.sid); } catch (e) { o = null; }
        if (o && o.ok) {
          onlineOk = true;
          onlineTotal = o.total || 0;
          rows.push(['Steam 账号全量（联网·主）',
                     (o.total || 0) + ' 款（新增 ' + (o.added || 0) + '）']);
          if (o.newIds && o.newIds.length) newIds = o.newIds;
          if (o.stale) {
            // stale 有两种原因，解法相反：Key 被拒要**去换一把**，链路抖动等一会儿就好。
            // 都用"这次没连上 Steam"会把用户指向错的方向（而这正是修这条链路的起因）。
            onlineBad = o.staleMessage ||
              (o.keyRejected ? 'API Key 被拒绝，用的是上次的结果'
                             : '这次没连上 Steam，用的是上次的结果');
            rows.push([o.keyRejected ? '⚠️ API Key 被拒绝' : '⚠️ 这次没连上 Steam',
                       '显示的是上一次的结果']);
          }
        } else {
          const reason = (o && o.reason) || 'unknown';
          // 服务端给的 message 更具体（它知道是没 key、还是资料没公开）→ 优先用它
          onlineBad = (o && o.message) || onlineFailText(reason);
          rows.push(['联网补全量失败', onlineBad]);
          // 隐私设置是最常见的失败原因，而且"怎么改"能写得很具体 ——
          // 提示条 3 秒就没了，所以既弹提示也**记进「消息」**，事后能翻照着做。
          if (o && o.howToFix && o.howToFix.length) {
            note('读不到你的游戏库。' + (o.message || '') + '\n' +
                 o.howToFix.map((s, i) => (i + 1) + '. ' + s).join('\n'), 'err');
          }
        }
      } else {
        rows.push(['联网补全量', '未绑定账号 —— 设置 →「Steam 账号」']);
      }

      // ---- ②.5 Steam 愿望单（「愿望单 -> 待游玩」）----
      //
      // 🔴 为什么这一步以前不存在、现在必须有（2026-09-24 用户实测：
      //    绑好 STEAMID + 新 Key、同步跑完，「待游玩」还是 0）：
      //    愿望单那条链（`/api/steam/wishlist` + `DS.mergeWishlist` + 卡片上的
      //    「未入库」角标）**早就全写好了**，但那时唯一的调用点在（2026-09-28 已
      //    下线的）云端路径里。桌面版的同步入口是这个函数，
      //    它原来只有 ①本机 ②联网 ③家庭库三步，**从来没有拉过愿望单**，
      //    于是 `status='backlog'` 的记录一条都建不出来，那个数字永远是 0，
      //    而且**没有任何报错**（静默缺失，比报错难查得多）。
      //
      // 顺序：排在 ② 之后、③ 之前。两条理由：
      //   · 和 ② 一样要"有账号 + 能出网"，紧跟 ② 失败信息才连得起来；
      //   · **必须在 ③ 之前** —— `store.js` 的 `mergeFamily` 对"我库里已有"的
      //     appid 一律跳过（连标记都不写）。愿望单先落记录，愿望单里的款就
      //     不会先被家庭库抢走 `source='family'`；被抢走的话它既不在「待游玩」、
      //     默认又被「家人拥有」开关藏着 = 在界面里**凭空消失**。
      //
      // ⚠️ 与 ② 同一条纪律：**不自己判「有没有 Key」**。缺 Key / Key 被拒是两种
      //    不同的原因（一个要申请、一个要更换），只有服务端分得清 —— 前端一旦
      //    自己短路，那段「为什么不行 + 怎么修」的文案就永远到不了用户眼前。
      //    所以只要有账号就**一律发出去**，由服务端归因。
      //    （`wish*` 那几个变量的声明在函数顶部 —— 理由见那里的注释。）
      if (p.sid) {
        setSyncStatus('正在读 Steam 愿望单…', '');
        let w = null;
        try { w = await window.GVLocal.syncWishlist(p.sid); } catch (e) { w = null; }
        if (w && w.ok) {
          wishOk = true;
          wishCount = w.count || 0;
          wishAdded = w.added || 0;
          wishIds = w.appids || [];
          rows.push(['Steam 愿望单', wishCount + ' 款（导入「待游玩」 ' + wishAdded + ' 款）']);
          if (w.removed) rows.push(['已从愿望单移除', w.removed + ' 款，一并删掉了']);
          if (w.kept) rows.push(['已不在愿望单但保留着', w.kept + ' 款（你动过它，不删）']);
        } else {
          wishReason = (w && w.reason) || 'unknown';
          wishBad = (w && w.message) || wishFailText(wishReason);
          rows.push(['Steam 愿望单', wishBad]);
          // 服务端给了修法就**记进「消息」**：提示条 3 秒就没了，而"把愿望单改成公开"
          // 这种要切到 Steam 去操作的事，用户得能回头照着做。
          if (w && w.howToFix && w.howToFix.length) {
            note('读不到你的 Steam 愿望单。' + (w.message || '') + '\n' +
                 w.howToFix.map((s, i) => (i + 1) + '. ' + s).join('\n'),
                 wishReason === 'steam_key_rejected' ? 'err' : 'warn');
          }
        }
      }

      // ---- ②.75 Steam 成就进度（「全成就 -> 已通关」）----
      //
      // 🔴 为什么这一步以前不存在、现在必须有（2026-09-29 排查发现）：
      //    `/api/steam/achievements` 在服务端**一直是活的**（并发分波 + 9 类失败
      //    判据 + `no_stats` 确定性答案），但唯一的调用点是随线上版一起删掉的云端
      //    路径。桌面版的同步入口是这个函数，它原来只有 ①本机 ②联网 ②.5愿望单
      //    ③家庭库 —— **从来没有核过成就**。于是 `game.achievements` 恒为 null：
      //    顶栏「全成就」恒 0、卡片永不挂勋章、`suggestStatus()` 的
      //    「全成就 -> 已通关」永不命中、排序「成就进度」全垫底，
      //    而**四个后果全是静默的**（没有报错，只能靠出图或逐项对数据看出来）。
      //    与 ②.5 愿望单那次是同一类缺陷（能力写好了、桌面版没接），差一天漏掉。
      //
      // 顺序：紧跟 ②.5、排在 ③ 之前。它和 ①②.5 一样是"我的库"这一组
      // （都要账号 + 出网），而 ③ 读的是**别人**的库，永远压轴。
      //
      // ⚠️ 同一条纪律：**不自己判「有没有 Key」** —— 缺 Key / Key 被拒 / 链路不通
      //    是三种不同的原因，只有服务端分得清。有账号就一律发出去，由它归因。
      //
      // ⚠️ 每轮只核一批（`ACH_BATCH` 款），从没核过的优先 —— 全库几百款分几次核完。
      //    所以这里必须把「还剩多少款没核」说到用户看得见的地方（明细 + 状态行），
      //    否则他会以为"点了同步什么都没发生"。
      //    （`ach*` 那几个变量的声明在函数顶部 —— 理由见那里的注释。）
      if (p.sid) {
        setSyncStatus('正在核对成就进度…', '');
        let a = null;
        try { a = await window.GVLocal.syncAchievements(p.sid); } catch (e) { a = null; }
        if (a && a.ok) {
          achOk = true;
          achAsked = a.asked || 0;
          achGot = a.got || 0;
          achLeft = a.left || 0;
          achRecollected = a.recollected || 0;
          if (a.nothingToDo) {
            achSkipped = true;
            rows.push(['成就进度', '已是最新（候选池里没有没核过的款）']);
          } else {
            rows.push(['成就进度',
              '本轮核了 ' + achGot + ' 款' +
              // 问了的比拿到的多 = 有几款这次没问到（仍在候选池里，下次重试）。
              // 不写这一句的话，"核了 118 款"会让人以为全部都核过了。
              (achAsked > achGot ? '（问了 ' + achAsked + ' 款，' +
                                   (achAsked - achGot) + ' 款这次没拿到，下次重试）' : '') +
              (achLeft > 0 ? '，还剩 ' + achLeft + ' 款没核 —— 再点一次「同步」接着来'
                           : '，已全部核完')]);
            if (achRecollected) {
              rows.push(['由「全成就」进「已通关」', achRecollected + ' 款']);
            }
            if (a.link && a.link !== 'ok') {
              rows.push(['⚠️ 成就链路', a.link === 'down' ? '整条不通' : '时好时坏']);
            }
          }
        } else {
          achReason = (a && a.reason) || 'unknown';
          achLeft = (a && a.left) || 0;
          achBad = (a && a.message) || achFailText(achReason);
          rows.push(['成就进度',
            achBad + (achLeft > 0 ? '（还有 ' + achLeft + ' 款没核）' : '')]);
          if (a && a.howToFix && a.howToFix.length) {
            note('读不到成就进度。' + (a.message || '') + '\n' +
                 a.howToFix.map((s, i) => (i + 1) + '. ' + s).join('\n'),
                 achReason === 'steam_key_rejected' ? 'err' : 'warn');
          }
        }
      }

      // ---- ③ 家庭库（桌面版专有）----
      //
      // 🔑 顺序放在 ② 之后，是**必须**的：①② 先把「我的」那份写完（含收藏夹、
      //    我的时长、我的状态），③ 才能准确判断"哪些 appid 我库里已经有了" ——
      //    `mergeFamily` 对已有的款一律不碰（连标记都不写）。
      //
      // 🔴 这一步读的是**别人**的库，和 ② 那份语义完全不同：
      //    ② 写 `totalMinutes`（我的时长），③ 只写 `familyOwners` / `familyMinutes`。
      //    两者绝不能混 —— store.js 的 mergeFamily 里钉着这一条。
      if (state.desktop && window.GVLocal && window.GVLocal.syncFamily) {
        // 顺手把面板那行「家庭库：家庭组…」刷出来（同一份数据，不重复请求）
        setSyncStatus('正在读本机家庭组…', '');
        await refreshFamilyInfo();
        const fi = familyInfo || {};
        if (fi.state === 'none') {
          // 没加入家庭组是**正常状态**，不是错误 —— 一行事实就够了，不弹提示
          rows.push(['家庭库', '这个账号没加入 Steam 家庭组']);
        } else if (fi.state !== 'ok') {
          familyBad = fi.reason || '读不到家庭组成员名单';
          rows.push(['家庭库', familyBad]);
        } else {
          const otherN = fi.members.filter(m => m && !m.isMe).length;
          if (!otherN) {
            rows.push(['家庭库', '家庭组里只有你自己']);
          } else if (!plan.hasKey) {
            // 成员名单是**本机文件**读的（不需要 Key），但读他们的**库**需要 ——
            // 这里如实说出原因，而不是默默跳过让用户以为"家里就这些"。
            // 怎么申请：上面「数据来源」那行的链接，和 ② 那条失败的 howToFix 里都有。
            rows.push(['家庭库（' + otherN + ' 人）',
                       '要读他们的库得有 API Key —— 见上面「数据来源」那行的申请地址']);
          } else {
            setSyncStatus('正在读家庭成员的库…', '');
            let fr = null;
            try {
              fr = await window.GVLocal.syncFamily(function (i, n) {
                setSyncStatus('正在读家庭成员的库（' + i + '/' + n + '）…', '');
              });
            } catch (e) { fr = null; }

            if (!fr) {
              familyBad = '家庭库同步出错';
              rows.push(['家庭库', familyBad]);
            } else {
              // 逐人归因：**谁读到了、谁没读到、为什么** —— 一条都不能省。
              // 只报一句"近千款"却不说少了谁，用户会以为那就是全部。
              (fr.members || []).forEach(function (mm) {
                if (!mm.reason) return;
                const who = mm.name || ('账号 …' + String(mm.steamId || '').slice(-4));
                const why = mm.message || familyMissText(mm.reason);
                familyMissing.push(who + '：' + why);
                rows.push(['　· ' + who, why]);
              });
              if (fr.readable > 0) {
                familyOk = true;
                familyTotal = fr.total || 0;
                familyAdded = fr.added || 0;
                rows.push(['家庭库（' + fr.readable + '/' + fr.requested + ' 人读到）',
                           fr.total + ' 款（新增 ' + fr.added +
                           '；我已有的 ' + fr.skipped + ' 款原样没动）']);
                if (fr.stoppedEarly) {
                  rows.push(['⚠️ 这次时间用完了',
                             '还有成员没读完 —— 再点一次「重新同步」会接着读（已读到的有服务端缓存）']);
                }
              } else {
                familyBad = '一个成员的库都没读到';
                rows.push(['家庭库', familyBad]);
              }
            }
          }
        }
      }
    } catch (err) {
      setSyncStatus('同步出错：' + ((err && err.message) || err), 'err');
    } finally {
      syncBusy = false;
      el.syncLocalBtn.disabled = false;
    }

    el.syncDiff.innerHTML = rows.map((row) =>
      '<div class="dl"><span>' + esc(row[0]) + '</span><b>' + esc(row[1]) + '</b></div>'
    ).join('');

    // 任一半成功都要刷新界面 —— **只成功联网那半时同样得刷**（换台机器、
    // 本机没装 Steam 就是这种情形：全量库照样拿得到）。③ 同理。
    //
    // ⚠️ ③ 与 ②.5 / ②.75 **不能只判 `onlineOk`**：愿望单、成就、全量库是**三个
    //    各自出网的接口**，"全量库那次失败、成就那次成功"完全可能发生。
    //    只判 `onlineOk` 会让已经写进库的成就**不刷新** —— 用户看到的是
    //    "同步完成"，界面上的「全成就」却还是 0（另一处静默不一致）。
    if (localOk || onlineOk || familyOk || wishOk || achOk) {
      await reload();
      if (el.setMask.hidden) render();

      const total = state.games.length;
      let msg = '同步完成：共 ' + total + ' 款';
      // 说清这一轮的数据**主要来自哪** —— 用户真正关心的是"全不全"，
      // 而不是"同步跑了几步"。
      if (onlineOk) {
        msg += '（联网全量 ' + onlineTotal + ' 款为主' +
               (localOk ? '，本机补充收藏夹 / 本地封面' : '，本机这半没读成') + '）';
      } else if (onlineBad) {
        msg += '（仅本机：' + onlineBad + '）';
      }
      if (newIds.length) msg += '，联网新补 ' + newIds.length + ' 款';
      // 愿望单的结果要进**状态行**（那是用户唯一会读的一行）：
      // 导入成功就说清进了几款到哪儿；失败就说原因 —— 不然用户只能看到
      // 「同步完成」却找不到那些想玩的游戏，而这就是他点同步的目的。
      if (wishOk) {
        msg += '，愿望单 ' + wishCount + ' 款（新进「待游玩」 ' + wishAdded + ' 款）';
      } else if (wishBad) {
        msg += '。愿望单没读成：' + wishBad;
      }
      // 成就那一步同理：核了就说清"还剩多少"（那是用户唯一会读的一行，
      // 而「每轮只核一批」正是要他知道再点一次能继续），没核成就说原因。
      if (achOk && !achSkipped) {
        msg += '，成就核了 ' + achGot + ' 款' +
               (achLeft > 0 ? '（还剩 ' + achLeft + ' 款，再点一次接着核）'
                            : '（已全部核完）');
      } else if (achBad) {
        msg += '。成就没核成：' + achBad;
      }
      if (familyOk) {
        msg += '，家庭库 ' + familyTotal + ' 款（新进来 ' + familyAdded + ' 款）';
        // 有家人没读到就必须在**状态行**上也点到 —— 状态行才是用户真正会读的那一行，
        // 明细里的原因他未必看得见。少了谁 = 这份并集不全。
        if (familyMissing.length) {
          msg += '，其中 ' + familyMissing.length + ' 位家人没读到（见明细）';
        }
      } else if (familyBad) {
        msg += '。家庭库没读成：' + familyBad;
      }
      if (!localOk && localBad) msg += '。本机没读成：' + localBad;
      // 本机那半失败、家庭库有家人没读到，都要算"需要看一眼" ——
      // 否则状态行一句干净的「同步完成」会把它们盖掉。
      //
      // ⚠️ 愿望单那半有个刻意的区分：`unavailable`（愿望单为空**或**没公开）
      //    Steam 给的是同一份数据，分不开 —— 它既可能是"你本来就没愿望单"
      //    （完全正常），也可能是"隐私没开"（要去改）。这种情况**不算 bad**，
      //    只在明细里如实写两种可能，免得每月看十几遍黄字。
      //    其余原因（没 Key / Key 被拒 / 链路不通）是**真的没读到**，算 bad。
      const wishHard = !!wishBad && wishReason !== 'unavailable' && wishReason !== 'empty';
      const bad = !!onlineBad || !localOk || !!familyBad || wishHard ||
                  !!achBad || familyMissing.length > 0;
      setSyncStatus(msg + '。', bad ? 'warn' : 'ok');
      note(msg, bad ? 'warn' : 'ok');

      // 家人的库读进来后，那份清单**默认是收起来的**（一次几百款，摊在总库里没法看）。
      // 所以必须告诉用户"东西在哪儿、怎么打开" —— 否则他会以为同步什么都没发生。
      if (familyAdded > 0) {
        note('家庭库进来了 ' + familyAdded + ' 款，默认**不显示在总库里**。' +
             '想看就点「筛选」→ 打开「家人拥有」。', 'ok');
      }

      // 愿望单刚进来的款**连名字都还没有**（愿望单接口只给 appid），卡面会先显示成
      // 「App <appid>」占位。这句话要主动说，否则用户会以为导入进来一堆坏数据 ——
      // 他打开「待游玩」看到的第一眼就是这个。
      if (wishAdded > 0) {
        note('愿望单进来了 ' + wishAdded + ' 款，都在「待游玩」区块。' +
             '名字和封面正在后台补（补之前卡面显示「App <appid>」占位，下次同步还会接着补）。',
             'ok');
      }

      // 「全成就 -> 已通关」是自动归类里**唯一一条用户看不见就会困惑**的规则：
      // 几款游戏突然从「正在游玩」跳到「已通关」，不说一声他会以为归类坏了。
      if (achRecollected > 0) {
        note(achRecollected + ' 款拿了全成就，已自动归档到「已通关」。', 'ok');
      }

      // 联网新进来的款本机没有封面，愿望单刚进来的**连名字都没有** ——
      // 两类都优先去补，愿望单的排最前（「App 12345」比"有名字没封面"更难看）。
      // ⚠️ 这里给大额度（META_BULK_LIMIT）：用户刚点完同步人就在屏幕前等，
      //    而 45 一款一款地补，愿望单一次进来几百款就是几百张占位卡。
      fillMetaInBackground(wishIds.concat(newIds), META_BULK_LIMIT);
    } else {
      // ---- 两半都没成 ----
      //
      // 🔴 这里**必须**落一个终态。不然状态行会一直挂着 ② 那句
      //    「正在问 Steam 要全量库…」—— 一个**中间态**，用户看着它以为还在转圈，
      //    既不知道本机为什么没读成，也等不到任何结论（实测过）。
      //    而且两边的原因都要说：本机缺 Steam 目录、联网缺 Key 是**两件独立**的事，
      //    以前只报后一句，用户照做了也不会好。
      let msg = '同步没读成任何东西';
      if (localBad) msg += '。本机：' + localBad;
      if (!plan || !plan.sid) {
        msg += '。联网：未绑定账号 —— 设置 →「Steam 账号」';
      } else if (onlineBad) {
        msg += '。联网：' + onlineBad;
      }
      if (familyBad) msg += '。家庭库：' + familyBad;
      if (achBad) msg += '。成就：' + achBad;
      setSyncStatus(msg + '。', 'err');
      note(msg + '。', 'err');
    }
  }

  async function onSyncFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      // 解析统一走 readBackupFile —— 和设置里的「从文件导入」是**同一份实现**。
      // （prefs 恢复 / 旧分类名认领 / 建议状态 的顺序都在里面，见那个函数的注释）
      const r = await readBackupFile(f);
      if (!r.ok) {
        setSyncStatus(r.reason, 'warn');
        el.syncApply.disabled = true;
        return;
      }
      const prepared = r.prepared;

      const existing = state.games;
      const byAppid = new Map();
      existing.forEach(g => { if (g.appid != null) byAppid.set(String(g.appid), g); });

      let addCount = 0, updCount = 0, playCount = 0, doneCount = 0;
      prepared.forEach(p => {
        const old = byAppid.get(String(p.appid));
        if (old) updCount++; else addCount++;
        if (p.suggestedStatus === S.PLAYING) playCount++;
        if (p.suggestedStatus === S.COMPLETED) doneCount++;
      });

      state.syncPayload = prepared;

      el.syncDiff.innerHTML =
        '<div class="dl"><span>文件中的游戏</span><b>' + prepared.length + '</b></div>' +
        '<div class="dl"><span>新增</span><b>' + addCount + '</b></div>' +
        '<div class="dl"><span>更新（已存在）</span><b>' + updCount + '</b></div>' +
        '<div class="dl"><span>其中会自动进「正在游玩」</span><b>' + playCount + '</b></div>' +
        '<div class="dl"><span>其中会自动进「已通关」</span><b>' + doneCount + '</b></div>' +
        '<div style="margin-top:9px;color:var(--text-faint);font-size:11.5px">' +
          '⚠️ 你手动标记过状态的游戏不会被覆盖。' +
        '</div>';

      setSyncStatus('文件解析成功，可以应用了。', 'ok');
      el.syncApply.disabled = false;
    } catch (err) {
      setSyncStatus('解析失败：' + err.message, 'err');
      el.syncApply.disabled = true;
    }
  }

  async function applySync() {
    if (!state.syncPayload) return;
    el.syncApply.disabled = true;
    setSyncStatus('正在写入…', '');
    try {
      const res = await DS.mergeSteam(state.syncPayload);
      await reload();
      // 🔴 reload() 只刷新 state.games，**不重绘** —— 少了这一行，
      //    写完库之后界面还是旧的（这张弹窗 1.1 秒后自动关掉，用户回到列表
      //    看到的还是导入前那份，得点一下筛选/切个区块才刷新）。
      render();
      const msg = '同步完成：新增 ' + res.added + ' 款，更新 ' + res.updated + ' 款';
      setSyncStatus(msg + '。', 'ok');
      // 这个弹窗 1.1 秒后自动关闭，光靠弹窗里的状态文字用户多半没看清，
      // 所以补一条提示条 —— 它同时会记进「消息」历史，事后能翻。
      note(msg, 'ok');
      setTimeout(closeSyncModal, 1100);
    } catch (err) {
      setSyncStatus('写入失败：' + err.message, 'err');
      note('同步写入失败：' + err.message, 'err');
      el.syncApply.disabled = false;
    }
  }

  // ===== 备份：导出 / 导入（设置 →「数据备份」）=====
  // 2026-09-22 需求：这两个动作是「换电脑搬数据」一件事的两半，原来却被拆到
  // 两个地方 —— 导出在页脚的小文字链（#btnExport），导入藏在「同步」弹窗里。
  // 现在都收进设置，并且**导出与导入共用同一份字段表/解析函数**（见下）。

  /**
   * 导出载荷。导出与导入必须用同一份字段表 —— 少一个字段，换台机器导回去
   * 就是一次静默的数据缺失（用户不会发现，直到发现归类全变了）。
   *
   * 🔴 `prefs` 不能漏。它决定「哪个收藏夹算已通关」：不带上的话，新机器会按
   * 默认名（「已完结」）重算归类 —— 旧版本默认名「完结撒花」下的数十款会整片落回
   * 「我的游戏单」。线上版早期就是这么漏的。
   */
  function backupPayload(all) {
    return {
      app: 'MyGameVaultList', version: 1,
      exportedAt: new Date().toISOString(),
      prefs: DS.getPrefs(),
      games: all
    };
  }

  /** 导出到文件（设置里的按钮；以前是页脚的 #btnExport） */
  async function exportBackupToFile() {
    setBackupState('', '');
    try {
      const all = await DS.all();
      if (!all.length) {
        setBackupState('当前没有可导出的数据。', 'warn');
        note('当前没有可导出的数据', 'warn');
        return;
      }
      const blob = new Blob([JSON.stringify(backupPayload(all), null, 1)],
                            { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mygamevaultlist-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setBackupState('已导出 ' + all.length + ' 款记录。', 'ok');
      note('已导出 ' + all.length + ' 款数据', 'ok');
    } catch (e) {
      const m = '导出失败：' + ((e && e.message) || e);
      setBackupState(m, 'err');
      note(m, 'err');
    }
  }

  /**
   * 解析一个文件 -> 可以直接喂给 DS.mergeSteam 的数组。
   *
   * **同步弹窗（onSyncFile）和「数据备份」共用这一个**：两条入口对"文件里是什么"
   * 的理解必须一致，各抄一份迟早分叉（复制粘贴的代码不会一起改）。
   *
   * 三件必须按顺序做的事（顺序反了归类会错）：
   *   1. 先恢复 prefs —— 第 3 步算状态要用它判断"哪个收藏夹算已通关"
   *   2. 再 adoptLegacyCollection —— 认下旧版的分类名，否则那些款会落回「我的游戏单」
   *   3. 最后算 suggestedStatus
   */
  async function readBackupFile(file) {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : (data.games || []);
    if (!list.length) return { ok: false, reason: '这个文件里没有游戏数据。' };

    if (data && data.prefs) DS.setPrefs(data.prefs);
    DS.adoptLegacyCollection(list);

    const prepared = list.map(src => {
      const g = DS.makeGame(src);
      return Object.assign({}, g, {
        // 🔴 `src.status || …`：**有就沿用、没有才推算**。
        //   · 备份文件（本应用自己导出的）每款都带 status，那是用户的归类结果 ——
        //     重新推算等于把"手动标的已通关 / 放弃"抹掉，这正是「换电脑搬数据」
        //     最不能出错的地方。
        //   · 同步文件（scripts/sync.py 生成的）字段表里**没有** status，
        //     所以照旧走推算 —— 与本次改动前逐字一致。
        suggestedStatus: src.status || DS.suggestStatus(g)
      });
    });
    return { ok: true, prepared };
  }

  /**
   * 从文件导入（设置里的按钮）：**直接合并**，不走"先预览再应用"那一步。
   * 为什么可以省掉预览：这是用户从设置里主动点的，且 mergeSteam 是**合并不是替换**
   * —— 删不掉任何东西，最坏情况是覆盖同 appid 的几个字段。失败/数量都会走
   * note() 记进消息历史，事后能查。
   */
  async function importBackupFile(file) {
    setBackupState('正在读取文件…', '');
    try {
      const r = await readBackupFile(file);
      if (!r.ok) {
        setBackupState(r.reason, 'warn');
        note(r.reason, 'warn');
        return;
      }
      const res = await DS.mergeSteam(r.prepared);
      await reload();
      // 🔴 必须无条件重绘：这里是从**设置面板里**点的，面板还开着 ——
      //    以前写的 `if (el.setMask.hidden) render()` 会让重绘被跳过，
      //    于是关掉设置之后网格和顶部统计还是导入前那份（数据其实已经进去了，
      //    界面在骗人）。面板开着时重绘是看不见的，代价为零。
      render();
      let msg = '备份导入完成：新增 ' + res.added + ' 款，更新 ' + res.updated + ' 款';
      if (res.locked) msg += '（' + res.locked + ' 款手动锁定的记录未改动）';
      setBackupState(msg + '。', 'ok');
      note(msg, 'ok');
    } catch (e) {
      const m = '导入失败：' + ((e && e.message) || e);
      setBackupState(m, 'err');
      note(m, 'err');
    }
  }

  function setBackupState(text, kind) {
    el.setBackupState.className = 'set-status' + (kind ? ' is-' + kind : '');
    el.setBackupState.textContent = text || '';
  }

  // ===== 设置：收藏夹 -> 状态 =====

  /** 「a，b、c」-> ['a','b','c']（中英文逗号、顿号都当分隔符） */
  function splitNames(v) {
    return String(v == null ? '' : v).split(/[,，、]/)
      .map(s => s.trim()).filter(Boolean);
  }

  /**
   * 打开设置。候选（输入框的下拉 + 下面那排小圆片）来自
   * **数据里实际出现过的收藏夹名** —— 用户多半不记得自己在 Steam 里
   * 把它们叫什么，纯靠手敲很容易差一个字，然后归类静默不生效。
   *
   * 桌面版还多一节「Steam 安装目录」（别的玩家的 Steam 不一定装在哪）。
   * 底部固定有「危险操作」一节（清空本机记录）—— 本地/桌面模式才显示。
   */
  async function openSettings() {
    const p = DS.getPrefs();
    el.setCompleted.value = p.completedCollections.join('，');
    el.setHidden.value    = p.hiddenCollections.join('，');
    renderCollectionCandidates();

    // ⚠️ 顺序：先让面板亮出来，再去问服务端。
    //    反过来（await 完再显示）在网络慢时会表现为"点了设置没反应"。
    el.setSteamSec.hidden = !state.desktop;
    el.setAcctSec.hidden = !state.desktop;
    // 「数据备份」与下面「危险操作」两节**常显**。它们原来是按云端模式藏起来的
    // （云端模式下备份在账号菜单里、清空也只清本机库，藏起来免得误导）。
    // 线上版 2026-09-28 下线后没有"另一种模式"了 —— 这里的判断与 HTML 上的
    // `hidden` 属性是**一对**，删就一起删：只删 JS 的话 `hidden` 会永远留着，两节再也出不来。
    setBackupState('', '');
    // 每次重开设置都把确认窗的闸门复位：上次勾过/点开过，不该带进这一次。
    // （不然「关闭设置 → 再打开 → 点清空」会直接出现一个已经勾好的确认框）
    el.wipeMask.hidden = true;
    resetWipeAck();
    if (state.desktop) {
      el.setSteamDir.value = '';
      el.setSteamFound.hidden = true;
      el.setSteamFound.innerHTML = '';
      el.setSteamState.className = 'set-status';
      el.setSteamState.textContent = '正在读取…';
      el.setAcctId.value = '';
      el.setAcctKey.value = '';
      el.setAcctDetect.hidden = true;
      el.setAcctDetect.innerHTML = '';
      el.setAcctState.className = 'set-status';
      el.setAcctState.textContent = '正在读取…';
    }
    el.setMask.hidden = false;

    if (state.desktop) await refreshSteamStatus();
  }

  function closeSettings() { el.setMask.hidden = true; }

  // ===== 危险操作：清空本机游戏记录（二级确认）=====
  // 路径：设置面板底部「清空全部游戏记录…」→ #wipeMask 确认窗 → 勾掉授权框
  // → 「确认清空」才真删。以前这条路挂在右上角「⋮」上、用两个 native confirm，
  // 2026-09-22 提出：那是高危动作，不该待在最外层，误触一下全库就没了。

  /** 闸门复位：没勾授权框，「确认清空」就一直是 disabled */
  function resetWipeAck() {
    el.wipeAck.checked = false;
    el.wipeGo.disabled = true;
  }

  /**
   * 数出「这一下会删掉什么」。
   * 刻意用**真实数量**而不是「所有数据」这种笼统说法 —— 确认窗的全部价值就在于
   * 让代价看得见。手写感想单独拎出来数：它是这里唯一「重新同步也补不回来」的东西，
   * 也是用户最该停下来想一秒的地方。
   */
  function wipeSummary() {
    const all = state.games || [];
    return {
      total: all.length,
      withNote: all.filter(g => g.myNote && String(g.myNote).trim()).length,
      manual:   all.filter(g => g.source === 'manual').length,
      wishlist: all.filter(g => g.source === 'wishlist').length,
      tidied:   all.filter(g => g.statusManualAt || g.statusLocked || g.favorite ||
                                g.hidden || g.status !== S.LIBRARY).length
    };
  }

  function openWipeConfirm() {
    const s = wipeSummary();
    const li = ['<li><b>' + s.total + '</b> 款游戏记录 <em>（整库，包含工具与已隐藏的）</em></li>'];
    if (s.tidied) {
      li.push('<li>状态归类与标记，<b>' + s.tidied + '</b> 款受影响 ' +
              '<em>（已通关 / 放弃区 / 锁定 / 隐藏）</em></li>');
    }
    if (s.withNote) {
      li.push('<li><b>' + s.withNote + '</b> 条你手写的感想 <em>（重新同步也补不回来）</em></li>');
    }
    if (s.manual)   li.push('<li><b>' + s.manual + '</b> 款手动添加的游戏</li>');
    if (s.wishlist) li.push('<li><b>' + s.wishlist + '</b> 款愿望单里的记录</li>');
    el.wipeList.innerHTML = li.join('');

    // 顺带写清「哪些不会动」。不写的话两头都会出事：
    // 想清干净的人以为没清干净，怕误删的人以为连账号一起删了。
    el.wipeKeep.innerHTML =
      '不会动：<code>Steam 账号与 API Key</code>、<code>Steam 安装目录</code>、' +
      '「哪个收藏夹算已通关」的设置、消息记录 —— 这些要单独在上面几节里改。<br>' +
      '手滑了的话：上面「数据备份 → 从文件导入」可以把之前导出的 JSON 导回来。';

    resetWipeAck();
    el.wipeMask.hidden = false;
    // 焦点给「取消」：默认落在安全的那一边（回车不会误确认）
    try { el.wipeCancel.focus(); } catch (e) { /* ignore */ }
  }

  function closeWipeConfirm() {
    el.wipeMask.hidden = true;
    resetWipeAck();
  }

  async function doWipe() {
    if (el.wipeGo.disabled) return;     // 闸门没开（防脚本/回车误触）
    const s = wipeSummary();
    el.wipeGo.disabled = true;          // 防连点：删一次就够
    try {
      await DS.clear();
      await reload();
      closeWipeConfirm();
      closeSettings();
      render();
      note('已清空本机 ' + s.total + ' 款记录' +
           (s.withNote ? '（含 ' + s.withNote + ' 条手写感想）' : '') +
           ' —— 要找回只能用之前导出的备份', 'warn');
    } catch (e) {
      el.wipeGo.disabled = false;
      closeWipeConfirm();
      note('清空失败：' + ((e && e.message) || e), 'err');
    }
  }

  // ===== 桌面版：Steam 安装目录 =====

  async function refreshSteamStatus() {
    if (!window.GVLocal) return;
    let st = null;
    try { st = await window.GVLocal.status(); } catch (e) { st = null; }
    desktopStatus = (st && st.desktop) ? st : null;
    renderSteamState();
  }

  /** 把「现在用的是哪个目录、哪来的」如实写出来 —— 这条信息决定用户要不要动手改 */
  function renderSteamState() {
    const st = desktopStatus;
    if (!st) {
      el.setSteamState.className = 'set-status is-err';
      el.setSteamState.textContent = '读不到本机状态（本机服务没有响应）';
      return;
    }
    // 输入框只填**用户显式设过的**那个；没设过就留空（空 = 走自动检测）
    el.setSteamDir.value = st.savedDir || '';

    const used = st.steamDir || '';
    let cls, line;
    if (!used) {
      cls = 'is-err';
      line = st.reason || '没有找到 Steam 安装目录';
    } else if (st.source === 'settings') {
      cls = 'is-ok';
      line = '正在使用你指定的目录：' + used;
    } else if (st.savedInvalid) {
      cls = 'is-warn';
      line = '你之前指定的目录已不可用（' + (st.savedReason || '原因不明') +
             '），暂时改用自动检测到的：' + used;
    } else {
      cls = 'is-ok';
      line = '自动检测到的目录：' + used;
    }
    el.setSteamState.className = 'set-status ' + cls;
    el.setSteamState.textContent = line;

    renderSteamFound(st.auto || [], '另外还检测到（点一下填进上面的框）：', '');

    // 账号那一节和目录共用同一份状态，一次刷新一起渲染
    renderAcctState();

    // 同步面板里那两行读的也是同一份状态 —— 用户刚把 Key 补上，
    // 面板上的「数据来源」必须当场跟着变，别等他关了设置再打开才发现。
    renderSyncLocalInfo();
  }

  // ===== 桌面版：Steam 账号 / API Key（联网同步，可选）=====

  /**
   * 「检测到本机账号」那一行。
   *
   * 🔴 **只当提示，不当结论** —— `loginusers.vdf` 里列的是"在这台机器上登录过"的账号，
   *    共用机器上未必是当前这个人。所以显示成"检测到"并给一个「填入」按钮，
   *    要不要用由用户点一下决定，绝不自动拿去联网读库（那会读到别人的库）。
   */
  function renderAcctState() {
    const st = desktopStatus;
    if (!st) {
      el.setAcctState.className = 'set-status is-err';
      el.setAcctState.textContent = '读不到本机状态（本机服务没有响应）';
      return;
    }
    // 输入框只填**用户显式绑过的**那个；没绑过就留空（空 = 不联网、只读本机）
    el.setAcctId.value = st.steamId || '';
    // key 是敏感值，服务端只回布尔 —— 所以输入框**永远不回填**，
    // 留空 = 不改动（见 onAcctVerify），想换就把新的粘进去。
    el.setAcctKey.value = '';

    if (st.steamId) {
      const hasKey = !!(st.hasApiKey || st.hasEnvKey);
      // ⚠️ 缺 Key 时**不能用绿色的 is-ok**：绑定成功那抹绿会让用户以为"配置齐了"。
      //    实测就是这么发生的 —— 绑了 SteamID、点同步只拿到本机数据，
      //    因为联网那半要 Key，而这条绿色提示里读不出这件事。
      el.setAcctState.className = 'set-status ' + (hasKey ? 'is-ok' : 'is-warn');
      el.setAcctState.textContent = hasKey
        ? ('已绑定账号 ' + st.steamId + '，API Key 已配置 —— 同步会联网取全量库')
        : ('已绑定账号 ' + st.steamId + '，但还缺 API Key —— 同步只能读本机，' +
           '拿不到「买了但从没碰过」的那些。Key 在下面那个链接免费申请（约 30 秒）。');
    } else {
      el.setAcctState.className = 'set-status';
      el.setAcctState.textContent = '未绑定 —— 同步只读本机 Steam 文件（少一批"买了没碰过"的）';
    }

    const auto = st.autoAccount;
    if (auto && auto.steamId && auto.steamId !== st.steamId) {
      el.setAcctDetect.hidden = false;
      el.setAcctDetect.innerHTML =
        '<span class="set-colls-label">检测到本机账号（点一下填入上面的框）：</span>' +
        '<button type="button" class="set-chip set-chip-dir" data-sid="' + esc(auto.steamId) + '">' +
          '<b>' + esc(auto.accountName || auto.steamId) + '</b>' +
          '<em>' + esc(auto.steamId) + (auto.others ? '　另有 ' + auto.others + ' 个账号' : '') + '</em>' +
        '</button>';
    } else {
      el.setAcctDetect.hidden = true;
      el.setAcctDetect.innerHTML = '';
    }
  }

  function onAcctDetectClick(e) {
    const btn = e.target.closest('.set-chip-dir');
    if (!btn) return;
    el.setAcctId.value = btn.getAttribute('data-sid') || '';
  }

  /**
   * 「验证并保存」：先把用户填的**解析成 SteamID64**，再落盘，**最后真问一次 Steam**。
   *
   * 为什么要先解析：`/id/<个性网址>` 和整条资料链接都得联网问 Steam 才知道对应谁，
   * 而存一个没解析的东西进去，之后每次同步都会莫名其妙地失败。
   *
   * 🔴 为什么最后那一步必须单独做（2026-09-24 修）：
   *    解析这一步**只对个性网址 / 资料链接生效** —— 填 17 位数字 ID 时它一个请求都不发。
   *    而绝大多数人填的就是数字 ID，于是「验证并保存」其实**从来没验证过 Key**：
   *    用户以为验过了，等真点同步才失败，而那时的报错又指向"网络"。
   *    所以这里显式调 `/api/steam/verify-key`，把"验 Key"变成一件**确定发生**的事。
   */
  async function onAcctVerify() {
    const rawId = (el.setAcctId.value || '').trim();
    const rawKey = (el.setAcctKey.value || '').trim();
    el.setAcctVerify.disabled = true;
    el.setAcctState.className = 'set-status';
    el.setAcctState.textContent = '正在验证…';

    try {
      let id = rawId;

      // 不是 17 位数字（可能是个性网址 / 资料链接）→ 让服务端解析
      if (id && !/^\d{17}$/.test(id)) {
        let r = null;
        try { r = await window.GVLocal.resolveSteamId(id); } catch (e) { r = null; }
        if (!r || r.error) {
          el.setAcctState.className = 'set-status is-err';
          el.setAcctState.textContent = (r && (r.message || r.error)) ||
            '解析失败：本机服务没有响应';
          return;
        }
        id = r.steamId || (r.steamid) || '';
        if (!id) {
          el.setAcctState.className = 'set-status is-err';
          el.setAcctState.textContent = '没能解析出 SteamID64';
          return;
        }
      }

      const body = { steamId: id };
      // key 留空 = **不改动**（不是"清空"）。服务端只回布尔、不回填明文，
      // 所以面板里平时就是空的；要清空得用「清除账号」。
      if (rawKey) body.steamApiKey = rawKey;

      const res = await window.GVLocal.setCredentials(body.steamId, body.steamApiKey);
      if (!res.ok) {
        el.setAcctState.className = 'set-status is-err';
        el.setAcctState.textContent = res.reason || '保存失败';
        return;
      }
      await refreshSteamStatus();
      // 只绑了 ID、没填 Key 的话，联网那半其实还没通 —— 别报成一句干净的
      // 「已保存」（那会让用户以为配置齐了，实测就是这么误判的）。
      const keyNow = !!(desktopStatus && (desktopStatus.hasApiKey || desktopStatus.hasEnvKey));

      if (id && keyNow) {
        // 🔴 真问一次 Steam。这一步以前缺了（见函数头注释）。三种结果**必须分开说**：
        //    验过了 / 被 Steam 拒绝（去换一把）/ 没问到（**没测出来**，别吓用户）。
        el.setAcctState.className = 'set-status';
        el.setAcctState.textContent = '正在问 Steam 确认这把 Key…';
        let v = null;
        try { v = await window.GVLocal.verifyKey(id); } catch (e) { v = null; }

        if (!v) {
          // 连本机服务都没答复 —— 这和"Key 不对"是两回事，不能混为一谈
          el.setAcctState.className = 'set-status is-warn';
          el.setAcctState.textContent = '已保存，但没能确认 Key（本机服务没有响应）';
          return;
        }
        if (v.ok === false) {
          el.setAcctState.className = 'set-status is-err';
          el.setAcctState.textContent = '已保存，但 Steam 拒绝了这个 Key —— ' +
            (v.message || '换一把再试');
          note('API Key 被 Steam 拒绝，联网同步暂时用不了。' +
               ((v.howToFix && v.howToFix.length)
                 ? '\n' + v.howToFix.map((s, i) => (i + 1) + '. ' + s).join('\n') : ''),
               'err');
          return;
        }
        if (v.ok === null) {
          // ⚠️ 「没问到」不等于「Key 不对」—— 这里绝不能报警，否则网络一抖用户就去白换 Key
          el.setAcctState.className = 'set-status is-warn';
          el.setAcctState.textContent = '已保存。' +
            (v.message || '这次没能问到 Steam，Key 是否有效没测出来');
          return;
        }
        el.setAcctState.className = 'set-status is-ok';
        el.setAcctState.textContent = '已绑定账号 ' + id +
          '，API Key 有效 —— 同步会联网取全量库';
        note('Steam 账号已保存：' + id + '，API Key 验证通过 —— 同步会联网取全量库', 'ok');
        return;
      }

      note('Steam 账号已保存：' + (id || '（已清空）') +
           (rawKey ? '，API Key 已更新' : '') +
           (id && !keyNow ? '\n⚠️ 还缺 API Key —— 没有它同步只能读本机（少一批"买了没碰过"的）。' +
                            '免费申请：' + STEAM_KEY_URL : ''),
           (id && !keyNow) ? 'warn' : 'ok');
    } finally {
      el.setAcctVerify.disabled = false;
    }
  }

  /** 清除账号 + Key —— 之后同步就只读本机 */
  async function onAcctClear() {
    el.setAcctClear.disabled = true;
    try {
      const res = await window.GVLocal.setCredentials('', '');
      if (!res.ok) { note('清除失败：' + (res.reason || '原因不明'), 'err'); return; }
      await refreshSteamStatus();
      note('已清除 Steam 账号与 API Key，同步只读本机数据', 'ok');
    } finally {
      el.setAcctClear.disabled = false;
    }
  }

  /**
   * 候选列表（圆片）。`label` / `meta` 可以为空。
   * 点圆片只**填进输入框**，不直接保存 —— 和「恢复默认」同一个规矩：
   * 面板里改的选择，一律要点「保存」才生效，不做半截应用。
   */
  function renderSteamFound(items, label, meta) {
    items = items || [];
    if (!items.length && !meta) {
      el.setSteamFound.hidden = true;
      el.setSteamFound.innerHTML = '';
      return;
    }
    let html = '';
    if (label) html += '<span class="set-colls-label">' + esc(label) + '</span>';
    html += items.map((it) =>
      '<button type="button" class="set-chip set-chip-dir" data-dir="' + esc(it.path) + '">' +
        '<b>' + esc(it.path) + '</b>' +
        (it.source ? '<em>' + esc(it.source) + '</em>' : '') +
      '</button>').join('');
    if (meta) html += '<span class="set-colls-label">' + esc(meta) + '</span>';
    el.setSteamFound.hidden = false;
    el.setSteamFound.innerHTML = html;
  }

  function onSteamFoundClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('.set-chip') : null;
    if (!btn) return;
    el.setSteamDir.value = btn.getAttribute('data-dir') || '';
    el.setSteamState.className = 'set-status is-warn';
    el.setSteamState.textContent = '已填入 —— 点「保存」后生效';
  }

  /** 「改回自动检测」：清空输入框（同样是保存后才生效） */
  function onSteamClear() {
    el.setSteamDir.value = '';
    el.setSteamState.className = 'set-status is-warn';
    el.setSteamState.textContent = '已清空 —— 点「保存」后改回自动检测';
  }

  /**
   * 扫盘找 Steam。
   *
   * ⚠️ 它会**阻塞用户等待**（后端有三个上限：深度 3 / 4000 个目录 / 25 秒），
   *    所以必须有「正在扫描 + 按钮禁用」的反馈，并且**禁用期间忽略重复点击** ——
   *    一次扫全盘已经够重了，连点就是几份全盘 IO 叠在一起。
   */
  async function onSteamScan() {
    if (!window.GVLocal || el.setSteamScan.disabled) return;
    const btn = el.setSteamScan;
    const oldLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = '正在扫描…';
    el.setSteamFound.hidden = false;
    el.setSteamFound.innerHTML = '<span class="set-colls-label">正在扫描各个磁盘，请稍候…</span>';

    let r = null;
    try { r = await window.GVLocal.scan(); } catch (e) { r = null; }

    btn.disabled = false;
    btn.textContent = oldLabel;

    if (!r) {
      el.setSteamFound.hidden = false;
      el.setSteamFound.innerHTML =
        '<span class="set-colls-label">扫描失败（本机服务没有响应）</span>';
      return;
    }

    const items = [];
    (r.installs || []).forEach((c) => items.push({ path: c.path, source: 'Steam 安装目录' }));
    (r.libraries || []).forEach((c) => items.push({ path: c.path, source: '游戏库（这里没有 steam.exe，不是安装目录）' }));

    const meta = '扫了 ' + (r.scanned || 0) + ' 个目录，用时 ' +
                 ((r.elapsedMs || 0) / 1000).toFixed(1) + ' 秒' +
                 (r.truncated ? '（到上限提前停了，可能没扫全）' : '');
    renderSteamFound(items,
      items.length ? '扫描结果（点一下填进上面的框）：' : '这台机器上没扫到 Steam。',
      meta);
  }

  /**
   * 手动同步那一次「后台补名字/封面」的额度。
   *
   * 为什么比默认的 45 大出一截：45 是给**启动**那种"后台慢慢补、别拖慢开屏"
   * 的场景定的；而手动同步是用户**主动点、人就在屏幕前等**的场景，
   * 愿望单一次能进来几百款，45 一款一款地补意味着他接下来好几次启动都要
   * 面对一片「App 12345」。取 240 是照着"一次同步就该覆盖整个库"定的，同一套取舍。
   */
  const META_BULK_LIMIT = 240;

  /**
   * 桌面版：后台补全游戏名字与封面。
   *
   * 本机 Steam 文件只有已安装的款带名字（本机约 300 款里九成没名字），
   * 其余名字只能联网问商店接口（**免 key**）。几百款一款一次会很慢，
   * 所以默认每次只补一批（`GVLocal.fillMeta` 默认上限 45 款），
   * 进度存本机、下次接着补。
   *
   * ⚠️ **故意不 await**：先把界面交给用户，补全在后台推进 ——
   *    让启动时间取决于本机文件，而不是外网快不快。
   * ⚠️ 补完只在**没有弹窗打开**时重绘：用户可能正开着「设置」在填东西，
   *    这时整页重绘会把他的输入冲掉。
   *
   * `priorityIds` —— 排在队首的 appid（联网刚补进来的款、愿望单刚导入的款，
   * 本机没有名字也没有封面，最该先补）。会去重：`fillMeta` 内部不对入参去重，
   * 重复的会变成重复请求。
   *
   * `limit` —— 这一轮最多补多少款，默认交给 `GVLocal` 自己的上限（45）。
   * 手动同步那一次由 `syncDesktop` 传 `META_BULK_LIMIT`，见下面那个常量。
   *
   * 🔑 排完 `priorityIds` 之后**不是**直接铺 `state.games`（2026-09-24 改）：
   *    先排「**完全没名字**」的，再排其余。理由很实在 ——
   *    有名字没封面的卡只是不好看，完全没有名字的卡会渲染成「App 12345」，
   *    看上去像数据坏了。而"没名字"的款主要就来自愿望单那条路
   *    （愿望单接口只给 appid），所以它们必须优先挤进这 45 个名额，
   *    否则愿望单导进来 200 款、每轮只能补到其中零星几个，
   *    「待游玩」会长期是一片占位卡。
   */
  function fillMetaInBackground(priorityIds, limit) {
    if (!window.GVLocal || !window.GVLocal.fillMeta) return;
    const seen = {};
    const ids = [];
    const push = (a) => {
      if (a == null) return;
      const k = String(a);
      if (seen[k]) return;
      seen[k] = 1;
      ids.push(a);
    };
    (priorityIds || []).forEach(push);
    // ① 没名字的（愿望单导入的款就在这一档）—— 卡面退化成「App <appid>」，最该先补
    state.games.forEach(g => { if (!g.title) push(g.appid); });
    // ② 其余（有名字缺封面 / 都已经有了的，后者会被 fillMeta 自己滤掉 ——
    //    **唯一的例外是手动加的条目**：它的名封是我们自己拼的，所以"两样都有"这句
    //    对它成立，可类型/开发商/发售年还空着，守卫专门给它开了口子，
    //    理由见 local-src.js 里 `manualGap` 那段）
    state.games.forEach(g => push(g.appid));
    if (!ids.length) return;

    window.GVLocal.fillMeta(ids, limit).then(async (r) => {
      if (!r || !r.filled) return;
      await reload();
      // 用户正开着某一款的详情时，那一张也要重绘 —— `render()` 只管列表，不碰抽屉。
      // 🔴 少了这一步就是「手动添加完就没动静」：他刚点完候选、抽屉里打开那一款，
      //    类型/年份随后补上来了，可眼前那张还是旧的（连个变化都看不到）。
      //    `openDrawer` 是幂等的（重调=重绘并重新绑定），直接重调就行。
      if (state.drawerId) openDrawer(state.drawerId);
      if (el.setMask.hidden) render();      // 面板开着就别动它（见上面的说明）
      // ⚠️ 文案别退回「名字/封面」—— 手动条目这一路补的是类型/开发商/发售年，
      //    那款的名字和封面本来就有，照旧文案会说出一句用户看得见的假话。
      note('已补全 ' + r.filled + ' 款的资料' +
           (r.left ? '，还有 ' + r.left + ' 款下次启动继续' : '，已全部补齐'), 'ok');
    }).catch(e => console.warn('后台补全商店信息失败（不影响使用）', e));
  }

  function renderCollectionCandidates() {
    const names = DS.collectionsInData(state.games);

    el.setCollList.innerHTML = names
      .map(n => '<option value="' + esc(n) + '"></option>').join('');

    if (!names.length) {
      el.setColls.hidden = true;
      el.setColls.innerHTML = '';
      return;
    }
    el.setColls.hidden = false;
    el.setColls.innerHTML =
      '<span class="set-colls-label">你在 Steam 里的收藏夹：</span>' +
      names.map(n => '<button type="button" class="set-chip" data-coll="' +
                     esc(n) + '">' + esc(n) + '</button>').join('');
  }

  /** 点一个小圆片 -> 把它加进「归入已通关」那格（要删就在输入框里删） */
  function onCollectionChipClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('.set-chip') : null;
    if (!btn) return;
    const name = btn.getAttribute('data-coll') || '';
    if (!name) return;
    const cur = splitNames(el.setCompleted.value);
    if (cur.indexOf(name) < 0) cur.push(name);
    el.setCompleted.value = cur.join('，');
    el.setCompleted.focus();
  }

  /** 「恢复默认」只把输入框填回出厂值，点保存才真正生效 —— 不做半截应用 */
  function resetSettingsForm() {
    const d = DS.defaultPrefs();
    el.setCompleted.value = d.completedCollections.join('，');
    el.setHidden.value    = d.hiddenCollections.join('，');
    note('已填回默认值，点「保存」后生效', 'warn');
  }

  /**
   * 保存 + 当场重算归类。
   *
   * 状态是存在每条记录上的，光改偏好不会回头修正已同步的数据，所以这里必须
   * 重跑一遍 —— 否则用户改完设置盯着屏幕发现什么都没变，只会当成功能没生效。
   * 报告"进出各多少款"而不是只报成功，是因为「移出」同样会动用户的归档结果。
   *
   * 桌面版在这里还要处理「Steam 安装目录」：**先落盘（校验不过就原地报错、不关面板）**，
   * 再重新读一次本机库 —— 换了目录却不重读，用户改完只会看到一模一样的数据。
   */
  async function saveSettings() {
    // ---- ① Steam 安装目录（仅桌面版；校验通过才落盘）----
    // 比较前先归一化：`D:/Steam`、`D:\Steam\`、`d:\steam` 是同一个目录，
    // 不该因为写法不同就白跑一次保存 + 重新读库。
    const norm = (s) => String(s || '').trim().replace(/\//g, '\\')
                            .replace(/\\+$/, '').toLowerCase();
    let dirChanged = false;

    if (state.desktop && window.GVLocal) {
      const want = (el.setSteamDir.value || '').trim();
      const cur  = (desktopStatus && desktopStatus.savedDir) || '';
      if (norm(want) !== norm(cur)) {
        const r = await window.GVLocal.setSteamDir(want);
        if (!r.ok) {
          // 🔴 **不关面板**。关掉的话用户根本看不到错在哪，只会觉得"保存没反应"。
          el.setSteamState.className = 'set-status is-err';
          el.setSteamState.textContent = '没保存：' + (r.reason || '未知原因');
          note('Steam 目录没保存：' + (r.reason || '未知原因'), 'err');
          return;
        }
        dirChanged = true;
        desktopStatus = (r.data && r.data.status) || null;
      }
    }

    // ---- ② 收藏夹偏好 ----
    DS.setPrefs({
      completedCollections: el.setCompleted.value,
      hiddenCollections:    el.setHidden.value
    });
    closeSettings();

    const before = state.games.filter(g => g.status === S.COMPLETED).length;
    try {
      let dirMsg = '';
      if (dirChanged) {
        let r2 = null;
        try { r2 = await window.GVLocal.sync(); } catch (e) { r2 = null; }
        if (r2 && r2.ok) {
          dirMsg = '，已按新目录读到 ' + (r2.total || 0) + ' 款';
        } else {
          dirMsg = '，但按新目录读库失败（' +
                   ((r2 && r2.reason) || '本机服务没有响应') + '）';
        }
      }

      await DS.reclassifyOwned();
      await reload();
      const after = state.games.filter(g => g.status === S.COMPLETED).length;
      render();

      const d = after - before;
      let msg = '设置已保存';
      if (d > 0)      msg += '，' + d + ' 款新归入「已通关」';
      else if (d < 0) msg += '，' + (-d) + ' 款移出「已通关」';
      else            msg += '，归类结果没有变化';
      note(msg + dirMsg, dirChanged && !/已按新目录读到/.test(dirMsg) ? 'warn' : 'ok');
    } catch (err) {
      render();
      note('设置已保存，但重算归类失败：' + ((err && err.message) || err), 'err');
    }
  }

  /**
   * 提示 + 记进消息记录（js/msglog.js）。
   * 本地版原来只有弹窗里的状态文字和 alert，没有统一的提示通道；
   * 走同一个模块之后，本地版和云端版的消息都落在同一份历史里。
   */
  function note(msg, lv) {
    if (window.GVLog) GVLog.toast(msg, null, lv);
  }

  // ===== 数据加载 =====
  async function reload() {
    state.games = await DS.all();
  }

  // ===== 事件绑定 =====
  function bindEvents() {
    // 总库筛选：点按钮展开/收起选项；点面板外、或按 Esc 收起
    if (el.filterBtn) {
      el.filterBtn.addEventListener('click', () => {
        state.filterOpen = !state.filterOpen;
        render();
      });
    }
    document.addEventListener('click', (e) => {
      if (!state.filterOpen) return;
      if (el.filterBtn.contains(e.target)) return;    // 按钮自己那一下交给上面的监听
      if (el.filterPanel.contains(e.target)) return;  // 点选项不收起，方便连着开关几个
      state.filterOpen = false;
      render();
    });

    // 视图切换
    el.sortSeg.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        state.sort = b.dataset.sort;
        saveUiPrefs();
        render();
      });
    });

    // 已通关区：全成就分组开关
    if (el.groupPerfectBtn) {
      el.groupPerfectBtn.addEventListener('click', () => {
        state.groupPerfect = !state.groupPerfect;
        saveUiPrefs();
        render();
      });
    }

    // 暂停区：批量选择（进入 / 全选 / 标为放弃 / 退出）
    if (el.selectModeBtn) {
      el.selectModeBtn.addEventListener('click', () => {
        state.selectMode = true;
        state.selected = {};
        render();
      });
    }
    if (el.selExitBtn) {
      el.selExitBtn.addEventListener('click', () => { exitSelectMode(); render(); });
    }
    if (el.selAllBtn) {
      el.selAllBtn.addEventListener('click', toggleSelectAll);
    }
    if (el.selDropBtn) {
      el.selDropBtn.addEventListener('click', dropSelected);
    }

    // 搜索
    let timer = null;
    el.searchInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.search = el.searchInput.value.trim();
        render();
      }, 160);
    });

    // 添加
    el.btnAdd.addEventListener('click', openAddModal);
    el.modalClose.addEventListener('click', closeAddModal);
    el.modalCancel.addEventListener('click', closeAddModal);
    el.modalSave.addEventListener('click', saveNewGame);
    el.modalMask.addEventListener('click', (e) => {
      if (e.target === el.modalMask) closeAddModal();
    });
    el.mTitle.addEventListener('input', onTitleInput);
    el.mTitle.addEventListener('keydown', onTitleKeydown);
    if (el.mSuggest) el.mSuggest.addEventListener('click', onSuggestClick);
    // 焦点离开「名字」这一格去填别的字段 → 收起候选。
    // 之所以挂在**别的字段**上而不是给 mTitle 挂 blur：点候选时 blur 会先触发，
    // 把列表关掉就点不中了（这也是列表项用 div 而不是 button 的同一个理由）。
    [el.mAppid, el.mNote, el.mStatus].forEach(node => {
      if (node) node.addEventListener('focus', closeSuggest);
    });

    // 抽屉
    el.drawerClose.addEventListener('click', closeDrawer);
    el.drawerMask.addEventListener('click', closeDrawer);

    // 笔记
    el.noteClose.addEventListener('click', closeNoteEditor);
    el.noteCancel.addEventListener('click', closeNoteEditor);
    el.noteSave.addEventListener('click', saveNote);
    el.noteMask.addEventListener('click', (e) => {
      if (e.target === el.noteMask) closeNoteEditor();
    });

    // 同步
    // 「同步」按当前平台分派。**默认平台那条路一字不改** —— 还是原来那个面板
    //（它里面装着账号 / API Key / 家庭库 / 愿望单那一整套，只对默认平台成立）。
    // 别的平台走它注册表里挂的数据源；没有数据源 = 还没接入，按钮本来就置灰了。
    el.btnSync.addEventListener('click', () => {
      if (state.platform === PF.DEFAULT_ID) { openSyncModal(); return; }
      const src = PF.sourceOf(state.platform);
      if (src) { runPlatformSync(src); return; }
      note(PF.labelOf(state.platform) + ' 还没有数据源，暂时不能同步。', 'warn');
    });
    el.syncClose.addEventListener('click', closeSyncModal);
    el.syncCancel.addEventListener('click', closeSyncModal);
    el.syncFile.addEventListener('change', onSyncFile);
    el.syncApply.addEventListener('click', applySync);
    el.syncMask.addEventListener('click', (e) => {
      if (e.target === el.syncMask) closeSyncModal();
    });

    // 设置（收藏夹 -> 状态）
    el.btnSettings.addEventListener('click', openSettings);
    el.setClose.addEventListener('click', closeSettings);
    el.setSave.addEventListener('click', saveSettings);
    el.setReset.addEventListener('click', resetSettingsForm);
    el.setColls.addEventListener('click', onCollectionChipClick);
    el.setMask.addEventListener('click', (e) => {
      if (e.target === el.setMask) closeSettings();
    });
    el.setCompleted.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveSettings();
    });

    // 设置里的「Steam 安装目录」（面板只在桌面版显示，但绑定无条件做 ——
    // 元素在 index.html 里是静态存在的，条件绑定反而容易漏）
    el.setSteamFound.addEventListener('click', onSteamFoundClick);
    el.setSteamScan.addEventListener('click', onSteamScan);
    el.setSteamDetect.addEventListener('click', onSteamClear);
    el.setSteamDir.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveSettings();
    });

    // 账号那一节（联网同步）
    el.setAcctDetect.addEventListener('click', onAcctDetectClick);
    el.setAcctVerify.addEventListener('click', onAcctVerify);
    el.setAcctClear.addEventListener('click', onAcctClear);
    [el.setAcctId, el.setAcctKey].forEach((box) => {
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') onAcctVerify();
      });
    });

    // 同步面板里的两个按钮（桌面版才有）
    el.syncLocalBtn.addEventListener('click', syncDesktop);
    el.syncLocalSetup.addEventListener('click', async () => {
      closeSyncModal();
      await openSettings();
    });

    // 快捷键
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!el.noteMask.hidden) return closeNoteEditor();
        // 确认窗叠在设置之上 → 必须比设置先收掉，否则 Esc 会连设置一起关掉
        if (!el.wipeMask.hidden) return closeWipeConfirm();
        if (!el.modalMask.hidden) return closeAddModal();
        if (!el.syncMask.hidden) return closeSyncModal();
        if (!el.setMask.hidden) return closeSettings();
        if (!el.drawer.hidden) return closeDrawer();
        // 筛选选项是「展开了一层」的轻量状态，排在最前面收掉
        if (state.filterOpen) { state.filterOpen = false; return render(); }
        // 最后才退批量选择：抽屉/弹窗优先吃掉 Esc
        if (state.selectMode) { exitSelectMode(); return render(); }
      }
      // "/" 聚焦搜索
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT' &&
          document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault();
        el.searchInput.focus();
      }
    });

    // 🔴 「清空数据」只剩「设置 → 危险操作」一个入口。
    //    它原来挂在右上角「⋮」上，和「同步」「设置」并排，点一下就走 native confirm
    //    删库 —— 位置太外露、确认太轻，2026-09-22 搬进设置。那个按钮本身就是给云端
    //    账号菜单准备的挂载点，2026-09-28 随线上版下线一并删了。

    // ===== 危险操作：清空本机记录（设置里的入口 + 独立的确认窗）=====
    el.setWipe.addEventListener('click', openWipeConfirm);
    el.wipeCancel.addEventListener('click', closeWipeConfirm);
    el.wipeClose.addEventListener('click', closeWipeConfirm);
    // 勾选框就是确认键的闸门：不勾，按钮是 disabled 的
    el.wipeAck.addEventListener('change', () => {
      el.wipeGo.disabled = !el.wipeAck.checked;
    });
    el.wipeGo.addEventListener('click', doWipe);
    el.wipeMask.addEventListener('click', (e) => {
      if (e.target === el.wipeMask) closeWipeConfirm();   // 点空白 = 取消
    });

    // ===== 数据备份（设置里那一节）=====
    // 导出原来是页脚的 #btnExport，2026-09-22 搬进来；导入是它的对偶，
    // 一起待在这一节里（以前只能去「同步」弹窗选文件）。
    // 导入用一个**静态**的 hidden file input（不是临时 createElement）——
    // 无头测试要能往它上面挂文件、派 change，动态建的够不着。
    el.setBackupExport.addEventListener('click', exportBackupToFile);
    el.setBackupImport.addEventListener('click', () => {
      el.setBackupFile.value = '';      // 同一个文件连选两次也要能触发 change
      el.setBackupFile.click();
    });
    el.setBackupFile.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) await importBackupFile(f);
      e.target.value = '';              // 同上：别把上次的选择留着
    });
  }

  // ===== 启动 =====
  async function boot() {
    // ?local=1 强制走本地模式 —— 只用于调试和无头测试，正常访问不要加，
    // 加了就不会连云端，数据只存在这台设备上。
    //
    // 🔴 file:// 也一律走本地模式（2026-09-20 修）。
    // ⚠️ 这里原来有一段 `forceLocal`（`?local=1` 或 file:// 时跳过云端登录门）。
    //    线上版 2026-09-28 下线，「云端模式」这个概念没有了 —— 那段连同 cloudMode /
    //    state.cloud / `#btnMenu` 的隐藏 / `window.__gvRefresh` 一起删掉。
    //    留下来的教训：它存在的唯一原因是**多了一种运行模式**。「零依赖本地版：双击
    //    index.html」是本项目承诺的用法，可云 auth 只在已注册的 HTTPS 域可用 ——
    //    file:// 下永远拿不到会话 → boot() 停在登录门、**一张卡都渲染不出来**
    //    （实测 --dump-dom：有登录门、`class="card"` 计数 0）。别再引入第三种运行模式。
    //    `?local=1` 参数本身保留（测试页与截图脚本靠它钉本地模式，现在只是被忽略）。

    // ---- 桌面版探测（问卷，别猜）----
    // 只有桌面版启动器设了 GV_DESKTOP=1，也只有那时 /api/local/status 才存在。
    // 探测失败一律当「不是桌面版」——线上/双击打开时探测本来就会失败，这是正常路径。
    let desktop = null;
    if (window.GVLocal) {
      try { desktop = await window.GVLocal.probe(); } catch (e) { desktop = null; }
    }
    const desktopMode = !!desktop;
    // 记进 state：设置面板要不要显示「Steam 安装目录」那一节，就看它
    state.desktop = desktopMode;
    // 探测结果本身就是一份 `/api/local/status`，直接留给设置面板用（省一次请求）
    desktopStatus = desktopMode ? desktop : null;

    // ---- 先恢复上次存下的界面选项，再让 URL 参数覆盖 ----
    // 🔴 顺序不能反：URL 参数是"这一次打开就要这样"的明确指令
    //    （也是自动化验收的唯一入口），必须优先于存档值。
    //    放这么早还有个原因：它在 `reload()` / `render()` 之前，
    //    所以首屏就是用户上次离开时的样子，不会先闪一下默认值。
    loadUiPrefs();

    // ---- URL 参数先解析进 state ----
    // 放在 reload() / render() 之前：首屏就该是 URL 指定的样子，不要先闪一下默认值。
    // ?view=playing|backlog|paused|completed|library —— 方便直接分享/书签某个区块
    let initialView = null;
    try {
      const sp = new URLSearchParams(location.search);

      // ?plat=steam|epic —— 直接落在某个平台标签页上。
      // 和 ?view= / ?select= 一个路子：点标签页这个动作在无头验收（--dump-dom）
      // 里拿不到，必须给它留个入口；平时也能当书签用。
      // ⚠️ 只认注册表里登记过的 id（见 js/platforms.js）—— 拼错的参数静默忽略，
      //    不然会落在一个没有标签页的平台 id 上，界面看起来"什么都没有"。
      const qp = sp.get('plat');
      if (qp && PF.get(qp)) state.platform = qp;

      const q = sp.get('view');
      if (q && META[q]) initialView = q;

      // ?sort=achievement|playtime|title|release|lastPlayed
      const qs = sp.get('sort');
      if (qs && SORTS.indexOf(qs) >= 0) state.sort = qs;

      // ?group=1 —— 「已通关」区按全成就分组
      if (sp.get('group') === '1') state.groupPerfect = true;

      // ?hidetools=1 / ?hidedone=1 / ?hidedrop=1 —— 总库的三个过滤开关
      if (sp.get('hidetools') === '1') state.hideTools = true;
      if (sp.get('hidedone') === '1') state.hideCompleted = true;
      if (sp.get('hidedrop') === '1') state.hideAbandoned = true;

      // ?select=1 —— 直接进批量选择模式（暂停区用；也给自动化测试留个入口）
      if (sp.get('select') === '1') state.selectMode = true;

      // ?settings=1 —— 直接打开设置面板。
      // 桌面版的设置里有「Steam 安装目录」，这一步只能靠点按钮打开，
      // 无头验收（--dump-dom 拿不到点击）就没有入口了。和 ?select=1 一个路子。
      if (sp.get('settings') === '1') state._openSettings = true;
      // &scan=1 —— 面板打开后顺便点一次「扫描磁盘」（同上，只为让扫盘那条路可被自动验收）
      if (sp.get('scan') === '1') state._scanOnOpen = true;

      // ?sync=1 —— 直接打开同步面板。桌面版会**顺手跑一次本机同步**（见 openSyncModal）。
      //   同步面板只能靠点顶栏按钮打开，无头验收（--dump-dom 拿不到点击）就没有入口了，
      //   和 ?settings=1 / ?select=1 一个路子，平时也能当书签用。
      if (sp.get('sync') === '1') state._openSync = true;

      // ?open=<appid> —— 直接打开某款游戏的详情页。
      // 详情页顶部是**另一处画框**（.d-hero，同样 460/215），
      // 无头验收拿不到「点击卡片」这个动作，只能给它留个入口；平时也能当书签用。
      const qo = sp.get('open');
      if (qo && /^\d+$/.test(qo)) state._openGame = qo;
    } catch (e) { /* ignore */ }

    // ---- 事件绑定：早于数据加载 ----
    // 绑在 reload() 之前，用户点得快时不至于"点了没反应"。
    // （这里原来还有个 `window.__gvRefresh` —— 云端层登录完成后重绘用的钩子，
    //   唯一调用方是已下线的 cloud.js，2026-09-28 一并删了。）
    bindEvents();

    if (desktopMode) {
      // 桌面版：数据来自本机 Steam 文件（/api/local/library）。
      // 不灌 seed-data.js —— 那是给双击 index.html 用的**个人库快照**，
      // 桌面版要的是「这台机器上真实的库」，灌种子反而会用别人的数据盖住自己的。
      let r = null;
      try { r = await window.GVLocal.sync(); } catch (e) { console.error('本机数据读取失败', e); }
      if (!r || !r.ok) {
        const why = {
          steam_not_found: '没找到 Steam 安装目录 —— 去顶栏「设置」里指定，或点「扫描磁盘」找一下',
          no_account: '读不到已登录的 Steam 账号 —— 请先登录一次 Steam',
          fetch_failed: '读本机数据失败（本机服务没有响应）',
          no_datastore: '本地存储没准备好'
        }[r && r.reason] || '读取本机 Steam 数据失败';
        note(why, 'err');
      } else {
        const st = r.stats || {};
        console.log('[桌面版] 本机库 %d 款（已安装 %d / 有名字 %d / 有封面 %d / 有时长 %d）',
                    st.total || 0, st.installed || 0, st.named || 0,
                    st.withCover || 0, st.played || 0);
        if (st.total) {
          note('已读取本机 Steam：' + st.total + ' 款' +
               (r.added ? '（新增 ' + r.added + ' 款）' : ''), 'ok');
        }
      }
    } else if (window.__seedIfEmpty) {
      // 本地模式（直接双击 index.html）：空库时用内置数据灌一次
      try { await window.__seedIfEmpty(); } catch (e) { console.warn('seed failed', e); }
    }

    await reload();

    if (initialView) {
      // 用户明确指定了区块（或已收藏该链接）——即使为空也尊重
      state.view = initialView;
    } else if (!state.games.length) {
      state.view = S.BACKLOG;
    } else {
      // 有数据时，默认停在有内容的区块
      if (!countOf(S.PLAYING) && countOf(S.BACKLOG)) state.view = S.BACKLOG;
    }

    render();

    // 首屏停在某个**有数据源**的平台上时，顺手只读探一次（和点标签页那条路完全一致）。
    //
    // 🔴 为什么这一句必须有：`?plat=<id>` 是**直接落进**某个平台的入口（书签 / 无头验收），
    //    它不经过"点标签页"那个 handler。少了这一句，从链接进来的人看到的是第③种空态
    //    （"这里还空着"），而真相是第②种（"本机读不到、为什么、怎么修"）——
    //    出图时实测就是这样（`_shot_platform_epic.png` 早先那版写着"点「同步」载入 Steam 库"）。
    // ⚠️ 仍然只是**探测**：一个字节都不写库（见 runPlatformProbe 上面那段）。
    //    默认平台（steam）没挂通用数据源 → 这里什么都不会发生。
    {
      const src = PF.sourceOf(state.platform);
      if (src && !state.platNote[state.platform]) runPlatformProbe(src, state.platform);
    }

    // 桌面版：界面已经交给用户了，名字/封面在后台分批补（不阻塞启动，见函数说明）
    if (desktopMode) fillMetaInBackground();

    // ?open=<appid>：渲染完再开详情页（得等 state.games 就位）
    if (state._openGame) {
      const want = state._openGame;
      state._openGame = null;
      const g = (state.games || []).find(x => String(x.appid) === want);
      if (g) openDrawer(g.id);
    }

    // ?settings=1：渲染完再把设置面板弹出来（面板里的候选要用到已渲染的数据）
    if (state._openSettings) {
      state._openSettings = false;
      const wantScan = !!state._scanOnOpen;
      state._scanOnOpen = false;
      await openSettings();
      if (wantScan) await onSteamScan();
    }

    // ?sync=1：渲染完直接打开同步面板。桌面版这里会当场跑一次本机同步 ——
    // 故意不 await（和点按钮时一样，面板先出来，别让用户看着像卡住）。
    if (state._openSync) {
      state._openSync = false;
      openSyncModal();
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
