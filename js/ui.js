/*
 * GameVault — 界面逻辑
 * 依赖 store.js 暴露的 DataStore
 */

(function () {
  'use strict';

  const DS = window.DataStore;
  const S = DS.STATUS;
  const META = DS.STATUS_META;

  // ===== 应用状态 =====
  const state = {
    games: [],
    view: S.PLAYING,        // 当前视图（默认正在游玩）
    sort: 'lastPlayed',
    search: '',
    hideTools: false,       // 总库：是否隐藏工具/软件（默认显示，排底部独立一段）
    hideCompleted: false,   // 总库：是否隐藏已通关的游戏
    hideAbandoned: false,   // 总库：是否隐藏放弃区的游戏
    filterOpen: false,      // 总库筛选选项是否展开（纯界面状态，不持久化）
    groupPerfect: false,    // 「已通关」区：是否按全成就/非全成就分两段
    selectMode: false,      // 批量选择模式（暂停区里清理"不想再玩了"用）
    selected: {},           // 已选中的游戏 id（当 Set 用：{ id: true }）
    noteTargetId: null,
    syncPayload: null,
    desktop: false          // 是否跑在桌面版里（boot 里探测出来后置真）
  };

  /**
   * 桌面版最近一次 `/api/local/status` 的结果。
   * 打开设置面板时读它填输入框；用户在面板里改了目录、保存成功后再刷新它。
   */
  let desktopStatus = null;

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
    syncStatus:  $('#syncStatus'),
    syncDiff:    $('#syncDiff'),

    setMask:     $('#setMask'),
    setClose:    $('#setClose'),
    setSave:     $('#setSave'),
    setReset:    $('#setReset'),
    setCompleted:$('#setCompleted'),
    setHidden:   $('#setHidden'),
    setCollList: $('#setCollList'),
    setColls:    $('#setColls'),

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
    btnMenu:     $('#btnMenu'),
    btnExport:   $('#btnExport')
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

  /** 成就完成率 0~1；无成就数据返回 -1（排最后） */
  function achRatio(g) {
    const a = g.achievements;
    if (!a || !a.total || a.earned == null) return -1;
    return a.earned / a.total;
  }

  function sortGames(list) {
    const arr = list.slice();
    switch (state.sort) {
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
      list = state.games.slice();
      if (state.hideTools) {
        // 「隐藏非游戏」：滤掉真工具 + 被用户藏在「已隐藏」收藏夹里的游戏。
        // 这两类都不是你想在总库里浏览的内容。
        list = list.filter(g => !g.hidden);
      } else {
        // 默认展示：工具/软件排底部独立一段，
        // 但被用户主动隐藏的游戏不显示（它们需要靠上面那个开关才出来）。
        list = list.filter(g => !g.hidden || DS.isToolGame(g));
      }
      // 「隐藏已通关」：按状态判定，与是否全成就无关
      if (state.hideCompleted) list = list.filter(g => g.status !== S.COMPLETED);
      // 「隐藏已放弃」：把已经出局的清掉，剩下的才是你还在意的
      if (state.hideAbandoned) list = list.filter(g => g.status !== S.ABANDONED);
    } else {
      // 状态区块里，隐藏的游戏不出现
      list = state.games.filter(g => g.status === state.view && !g.hidden);
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

  /** 计数：状态区块排除隐藏项；总库跟随「隐藏非游戏 / 隐藏已通关 / 隐藏已放弃」三个开关 */
  function countOf(st) {
    if (st === S.LIBRARY) {
      return state.games.filter(g => {
        if (state.hideTools && g.hidden) return false;
        if (state.hideCompleted && g.status === S.COMPLETED) return false;
        if (state.hideAbandoned && g.status === S.ABANDONED) return false;
        return true;
      }).length;
    }
    return state.games.filter(g => g.status === st && !g.hidden).length;
  }

  /** 非游戏内容数量：真工具/软件 + 用户藏在「已隐藏」收藏夹里的游戏 */
  function hiddenCount() {
    return state.games.filter(g => g.hidden).length;
  }

  /** 总库里已通关的数量（供开关标注） */
  function completedCount() {
    return state.games.filter(g => g.status === S.COMPLETED).length;
  }

  /** 总库里已放弃的数量（供开关标注） */
  function abandonedCount() {
    return state.games.filter(g => g.status === S.ABANDONED).length;
  }

  // ===== 渲染：统计条 =====
  function renderStats() {
    // ⚠️ state.games 现在混着两种东西：Steam 库里的（已拥有）和只在愿望单里的
    // （未入库）。所以「游戏库」这个数**不能**再直接用 state.games.length ——
    // 那会把 300 款还没买的游戏算进库容量里。按 source 拆成两个数才对得上
    // 卡片角标，也才对得上用户在 Steam 里看到的情况。
    const owned = state.games.filter(g => g.source !== 'wishlist').length;
    const wished = state.games.filter(g => g.source === 'wishlist').length;
    const played = state.games.filter(g => (g.totalMinutes || 0) > 0).length;
    const totalMin = state.games.reduce((s, g) => s + (g.totalMinutes || 0), 0);
    const perfect = state.games.filter(g => DS.isPerfect(g)).length;
    const playing = countOf(S.PLAYING);
    const backlog = countOf(S.BACKLOG);

    const cards = [
      { label: '已拥有', value: owned, unit: '款' },
      { label: '未入库', value: wished, unit: '款' },
      { label: '总时长', value: Math.round(totalMin / 60), unit: '小时' },
      { label: '玩过', value: played, unit: '款' },
      { label: '正在玩', value: playing, unit: '款' },
      { label: '待玩', value: backlog, unit: '款' },
      { label: '全成就', value: perfect, unit: '款' }
    ];

    el.statsBar.innerHTML = cards.map(c =>
      '<div class="stat">' +
        '<div class="stat-label">' + esc(c.label) + '</div>' +
        '<div class="stat-value">' + c.value + '<small>' + esc(c.unit) + '</small></div>' +
      '</div>'
    ).join('');
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
        run: () => { state.hideAbandoned = !state.hideAbandoned; } }
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

    // 右下角：拥有状态（已拥有 / 未入库）。
    // 只在「我的游戏单」和「待游玩」两个区块渲染 —— 这两个区块里已拥有和
    // 愿望单来的款会混在一起，角标才有信息量。其余区块清一色都是已拥有的，
    // 每张卡都挂一个「已拥有」只是噪声。
    // DS.ownershipOf 对手动添加的款返回空串（判断不了就不标），见 store.js。
    const own = DS.ownershipOf(g);
    const ownFlag = (own && (state.view === S.LIBRARY || state.view === S.BACKLOG))
      ? '<div class="card-corner"><span class="cflag cflag-' +
          (own === 'owned' ? 'owned' : 'wish') + '">' +
          (own === 'owned' ? '已拥有' : '未入库') + '</span></div>'
      : '';

    // 批量选择模式才渲染勾选圈（避免平时白占几百个 DOM 节点）
    const showCheck = !!(opts && opts.selected);
    const isSel = !!(opts && opts.selected && opts.selected[g.id]);

    const img = g.header
      ? '<img src="' + esc(g.header) + '" alt="" loading="lazy" ' +
        'onerror="this.parentNode.innerHTML=\'<div class=&quot;noimg&quot;>◈</div>\'">'
      : '<div class="noimg">◈</div>';

    // 快捷收藏按钮（只在「我的游戏单」里出现）
    const quickBtn = showQuick
      ? '<button class="card-quick' + (inBacklog ? ' on' : '') + '" ' +
          'data-quick="' + esc(g.id) + '" ' +
          'title="' + (inBacklog ? '已在待玩清单，点击移出' : '加入待玩清单') + '">' +
          (inBacklog ? '★' : '☆') +
        '</button>'
      : '';

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
          '<span class="card-hours">' +
            (hours ? '<b>' + hours + '</b> h' : '&mdash;') +
          '</span>' +
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
    renderStats();
    renderNav();
    renderFilters();

    const m = META[state.view] || META[S.LIBRARY];
    el.viewTitle.textContent = m.label;
    el.brandSub.textContent = m.desc;

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
      el.emptyHint.textContent = state.search
        ? '没有匹配「' + state.search + '」的游戏。'
        : emptyHintFor(state.view);
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

    // 排序按钮态
    el.sortSeg.querySelectorAll('button').forEach(b => {
      b.classList.toggle('on', b.dataset.sort === state.sort);
    });

    // 这句话必须说实话：云端模式下数据在服务器上，不是「本机浏览器」。
    // 云端层（cloud.js）登录成功后会挂上 window.__gvStorageNote；
    // 没挂就是本机模式 —— 也正是双击 index.html 打开的那种情况。
    const storageNote = window.__gvStorageNote || '数据保存在本机浏览器';
    // 拆开说：总条数里混着愿望单的，只报一个「共 N 款」会让人以为库变大了。
    const nOwned = state.games.filter(g => g.source !== 'wishlist').length;
    const nWish = state.games.length - nOwned;
    el.footInfo.textContent = '已拥有 ' + nOwned + ' 款'
      + (nWish ? ' · 愿望单 ' + nWish + ' 款' : '')
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

  function emptyHintFor(st) {
    switch (st) {
      case S.PLAYING:   return DS.RECENT_DAYS + ' 天内启动过的游戏会自动出现在这里，也可以手动把游戏移进来。';
      case S.BACKLOG:   return '你想玩、还没开始的游戏放这里。点「同步」会把你 Steam 愿望单里的游戏自动导进来。';
      case S.PAUSED:    return '超过 ' + DS.RECENT_DAYS + ' 天没启动的游戏会自动落到这里；也可以手动把游戏移进来。';
      case S.COMPLETED: return '全成就、或收藏夹（默认「已完结」，可在「设置」里改）里的游戏会自动进来，也可以手动标记「已通关」。';
      case S.ABANDONED: return '这里是主动否掉的游戏。在「暂停区」点「批量选择」，或点开卡片改状态，都能把它挪进来。';
      default:          return '还没有游戏数据。点「同步」载入 Steam 库，或点「添加」手动录入。';
    }
  }

  // ===== 详情抽屉 =====
  function openDrawer(id) {
    const g = state.games.find(x => x.id === id);
    if (!g) return;
    el.drawerBody.innerHTML = drawerHtml(g);
    el.drawer.hidden = false;
    el.drawerMask.hidden = false;
    bindDrawer(g);
  }

  function closeDrawer() {
    el.drawer.hidden = true;
    el.drawerMask.hidden = true;
    el.drawerBody.innerHTML = '';
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
    const wishGame = g.source === 'wishlist';
    const stats = [];
    if (wishGame) {
      stats.push({ k: '加入愿望单', v: fmtDate(g.wishAddedTs) });
      if (g.wishPriority) stats.push({ k: '愿望单排序', v: '第 ' + g.wishPriority + ' 位' });
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

    // Steam 玩家评价（自动抓的）
    const steamReviewHtml =
      '<div class="d-sec">' +
        '<h4>Steam 评价</h4>' +
        (g.steamReview
          ? '<div class="d-note">' + esc(g.steamReview) + '</div>'
          : '<div class="d-note placeholder">暂未抓取到 Steam 评价，可在下方写自己的感想。</div>') +
      '</div>';

    // 我的记录
    const myNoteHtml =
      '<div class="d-sec">' +
        '<h4>我的游玩记录 <button id="editNoteBtn">编辑</button></h4>' +
        (g.myNote
          ? '<div class="d-note">' + esc(g.myNote) + '</div>'
          : '<div class="d-note placeholder">还没写。点「编辑」记下打到哪了、喜欢什么、哪里劝退。</div>') +
      '</div>';

    const steamLink = g.appid
      ? '<a class="d-link" href="https://store.steampowered.com/app/' + g.appid +
        '" target="_blank" rel="noopener">🔗 在 Steam 商店查看</a>'
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
        (g.header ? '<img src="' + esc(g.header) + '" alt="">' : '') +
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
        steamReviewHtml +
        devHtml +
        tagsHtml +
        '<div class="d-actions">' +
          steamLink +
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
    el.modalMask.hidden = false;
    setTimeout(() => el.mTitle.focus(), 50);
  }

  function closeAddModal() { el.modalMask.hidden = true; }

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
      // 手工游戏先留空；填了 AppID 的话，同步时会被商店信息补上
      // （cloud.js 的补全逻辑按 release_year 写回来）。
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
  }

  // ===== Steam 同步 =====
  function openSyncModal() {
    el.syncFile.value = '';
    el.syncPayload = null;
    el.syncApply.disabled = true;
    el.syncDiff.innerHTML = '';
    setSyncStatus('选择一个由 scripts/sync 生成的 JSON 文件。', '');
    el.syncMask.hidden = false;
  }

  function closeSyncModal() { el.syncMask.hidden = true; }

  function setSyncStatus(text, cls) {
    el.syncStatus.className = 'sync-status' + (cls ? ' ' + cls : '');
    el.syncStatus.textContent = text;
  }

  async function onSyncFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : (data.games || []);
      if (!list.length) {
        setSyncStatus('这个文件里没有游戏数据。', 'warn');
        el.syncApply.disabled = true;
        return;
      }
      // 备份文件里带着收藏夹设置（导出备份时会写进去）—— 在算建议状态之前
      // 先恢复它，否则换台设备导入备份，归类会按默认名重算一遍。
      if (data && data.prefs) DS.setPrefs(data.prefs);
      // 同理：先认下旧版的分类名，再算建议状态（顺序反了这些款会落成「我的游戏单」）
      DS.adoptLegacyCollection(list);

      // 预处理：补上建议状态
      const prepared = list.map(src => {
        const g = DS.makeGame(src);
        return Object.assign({}, g, {
          suggestedStatus: DS.suggestStatus(g)
        });
      });

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
   */
  async function openSettings() {
    const p = DS.getPrefs();
    el.setCompleted.value = p.completedCollections.join('，');
    el.setHidden.value    = p.hiddenCollections.join('，');
    renderCollectionCandidates();

    // ⚠️ 顺序：先让面板亮出来，再去问服务端。
    //    反过来（await 完再显示）在网络慢时会表现为"点了设置没反应"。
    el.setSteamSec.hidden = !state.desktop;
    if (state.desktop) {
      el.setSteamDir.value = '';
      el.setSteamFound.hidden = true;
      el.setSteamFound.innerHTML = '';
      el.setSteamState.className = 'set-status';
      el.setSteamState.textContent = '正在读取…';
    }
    el.setMask.hidden = false;

    if (state.desktop) await refreshSteamStatus();
  }

  function closeSettings() { el.setMask.hidden = true; }

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
   * 桌面版：后台补全游戏名字与封面。
   *
   * 本机 Steam 文件只有已安装的款带名字（本机约 300 款里九成没名字），
   * 其余名字只能联网问商店接口（**免 key**）。几百款一款一次会很慢，
   * 所以每次启动只补一批（`GVLocal.fillMeta` 上限 45 款），进度存本机、下次接着补。
   *
   * ⚠️ **故意不 await**：先把界面交给用户，补全在后台推进 ——
   *    让启动时间取决于本机文件，而不是外网快不快。
   * ⚠️ 补完只在**没有弹窗打开**时重绘：用户可能正开着「设置」在填东西，
   *    这时整页重绘会把他的输入冲掉。
   */
  function fillMetaInBackground() {
    if (!window.GVLocal || !window.GVLocal.fillMeta) return;
    const ids = state.games.map(g => g.appid).filter(a => a != null);
    if (!ids.length) return;

    window.GVLocal.fillMeta(ids).then(async (r) => {
      if (!r || !r.filled) return;
      await reload();
      if (el.setMask.hidden) render();      // 面板开着就别动它（见上面的说明）
      note('已补全 ' + r.filled + ' 款的名字/封面' +
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
        render();
      });
    });

    // 已通关区：全成就分组开关
    if (el.groupPerfectBtn) {
      el.groupPerfectBtn.addEventListener('click', () => {
        state.groupPerfect = !state.groupPerfect;
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
    el.mTitle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveNewGame();
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
    el.btnSync.addEventListener('click', openSyncModal);
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

    // 快捷键
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!el.noteMask.hidden) return closeNoteEditor();
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

    // 菜单按钮 -> 清空数据（带二次确认）
    el.btnMenu.addEventListener('click', async () => {
      if (!confirm('是否清空所有本地数据？\n\n（Steam 数据可以重新同步，但手写的记录会一并删除）')) return;
      if (!confirm('再确认一次：真的要清空吗？')) return;
      await DS.clear();
      await reload();
      render();
    });

    // 导出备份 -> 下载 JSON（与云端版导出格式一致，可直接被「同步」弹窗导入）
    if (el.btnExport) {
      el.btnExport.addEventListener('click', async () => {
        try {
          const all = await DS.all();
          if (!all.length) { note('当前没有可导出的数据', 'warn'); return; }
          const blob = new Blob([JSON.stringify({
            app: '我的游戏生涯', version: 1,
            exportedAt: new Date().toISOString(),
            // 收藏夹设置跟着走：它决定「哪个收藏夹算已通关」，
            // 不带上的话换设备导入备份会按默认名重算归类。
            prefs: DS.getPrefs(),
            games: all
          }, null, 1)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'gamevault-backup-' + new Date().toISOString().slice(0, 10) + '.json';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
          note('已导出 ' + all.length + ' 款数据', 'ok');
        } catch (e) {
          note('导出失败：' + ((e && e.message) || e), 'err');
        }
      });
    }
  }

  // ===== 启动 =====
  async function boot() {
    // ?local=1 强制走本地模式 —— 只用于调试和无头测试，正常访问不要加，
    // 加了就不会连云端，数据只存在这台设备上。
    //
    // 🔴 file:// 也一律走本地模式（2026-09-20 修）。
    // 「零依赖本地版：双击 index.html」是本项目承诺的用法，但云 auth 只在**已注册的
    // HTTPS 发布域**可用 —— file:// 下 getSession() 永远拿不到会话，于是每次双击都会
    // 停在登录门上，boot() 在 `if (!ok) return;` 处直接返回，**一张卡都渲染不出来**
    // （实测 --dump-dom：有 cvGate、class="card" 计数 0）。本地既然不可能登录成功，
    // 就不该给登录门。
    let forceLocal = false;
    try {
      forceLocal = /[?&]local=1\b/.test(location.search) ||
                   location.protocol === 'file:';
    } catch (e) { /* ignore */ }

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

    // 桌面版**也**不走云模式：它要的是「离线 + 本机数据」，
    // 云登录在桌面版里既没必要（数据就在本机），也走不通（OpenID 回调要注册过的 HTTPS 域）。
    const cloudMode = !!(window.Cloud && window.Cloud.enabled && !forceLocal && !desktopMode);

    // ---- URL 参数先解析进 state ----
    // 必须放在「云端登录」之前：登录界面期间 state 已经就位，
    // 登录完成后由 __gvRefresh 重绘时这些偏好才生效（如 ?sort=achievement）。
    // ?view=playing|backlog|paused|completed|library —— 方便直接分享/书签某个区块
    let initialView = null;
    try {
      const sp = new URLSearchParams(location.search);
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
    } catch (e) { /* ignore */ }
    state._initialView = initialView;

    // ---- 事件绑定与重绘钩子：必须早于云端登录流程 ----
    // 未登录时 boot() 会中途 return 去等用户登录，而登录成功后并不会整页刷新
    // （只有 Steam 绑定那一步会跳转回来）。所以这里先绑好：
    //   · bindEvents() 让排序 / 搜索 / 抽屉 / 快捷键在登录后立即可用
    //   · __gvRefresh 让云端层登录完成时能直接重绘，而不是停在空白页
    bindEvents();
    window.__gvRefresh = async function () {
      await reload();
      // 首次登录完成后，把 URL 里指定的区块补上（登录前 reload 还没跑过）
      if (state._initialView) { state.view = state._initialView; state._initialView = null; }
      render();
    };

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
    } else if (!cloudMode && window.__seedIfEmpty) {
      // 本地模式（直接双击 index.html）：空库时用内置数据灌一次
      try { await window.__seedIfEmpty(); } catch (e) { console.warn('seed failed', e); }
    }

    // 云端模式：先把登录 / Steam 绑定走完，数据接到云上再继续。
    // 未登录时 ready() 返回 false —— 登录界面已经显示，
    // 这里直接返回等用户操作，登录成功后由 __gvRefresh 接管重绘。
    if (cloudMode) {
      let ok = false;
      try {
        ok = await window.Cloud.ready();
      } catch (e) {
        console.error('云端初始化失败', e);
        note('云端初始化失败：' + ((e && e.message) || e), 'err');
        return;
      }
      if (!ok) return;
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
    state._initialView = null;   // 已生效，避免之后每次刷新又跳回 URL 指定的区块

    render();

    // 桌面版：界面已经交给用户了，名字/封面在后台分批补（不阻塞启动，见函数说明）
    if (desktopMode) fillMetaInBackground();

    // ?settings=1：渲染完再把设置面板弹出来（面板里的候选要用到已渲染的数据）
    if (state._openSettings) {
      state._openSettings = false;
      const wantScan = !!state._scanOnOpen;
      state._scanOnOpen = false;
      await openSettings();
      if (wantScan) await onSteamScan();
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
