/* ==========================================================================
   消息记录（GVLog）—— 底部提示条 + 可回看的历史
   ==========================================================================

   为什么要有它：
     同步一次会连着发好几条提示（「已同步 400 余款，正在补封面…」→
     「正在核对成就 12/60 …」→「同步完成：共 400 余款，新增…补上…没取到…」）。
     而提示条默认 2.6 秒就淡出，而且是**后一条直接盖掉前一条** ——
     用户往往只看到最后半句，偏偏那句才是「哪里没补完、下次会不会自动接着跑」
     的唯一说明。没有留痕，错过就是彻底没了。

   这里做四件事：
     1. 每条提示都记进本机历史，顶栏「消息」按钮带未读数，随时回看
     2. 显示时长按字数自适应（80 字那句从 2.6 秒 → 约 10 秒）
     3. 多条消息**排队依次显示**，不再互相覆盖
     4. 鼠标悬停暂停倒计时；点提示条直接打开历史

   存储：localStorage，只在本机浏览器，不跟账号走。
     「我在手机上没看清的那句话」本来就属于这个设备；存云端要新建表、
     加迁移、加 RLS 权限策略，收益不划算。

   这个文件必须**零依赖**：它比 ui.js 还先加载，而且有些测试页只引它、
   不引 ui.js（要单独验消息记录本身）。引任何东西都会把测试页拖垮。
   ========================================================================== */
(function (global) {
  'use strict';

  var KEY      = 'gv_msglog_v1';      // 消息列表，新 -> 旧
  var READ_KEY = 'gv_msglog_readat';  // 上次看面板的时间戳
  var MAX      = 100;                 // 最多留多少条
  var FADE     = 240;                 // 与 CSS 的 transition 对齐
  var LONG_MSG = 30;                  // 超过这么多字，提示条上多给一行「点击查看记录」

  var queue   = [];      // 排队等待显示的普通消息
  var el      = null;    // 提示条元素（常驻，靠 class 控制显隐）
  var timer   = null;
  var paused  = false;
  var showing = false;
  var panel   = null;

  // ---------------------------------------------------------------- 工具

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function fmtTime(ts) {
    var d = new Date(ts), now = new Date();
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (d.toDateString() === now.toDateString()) {
      return hm + ':' + pad(d.getSeconds());
    }
    var md = pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm;
    return d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '-' + md;
  }

  function normLevel(lv) {
    return (lv === 'ok' || lv === 'warn' || lv === 'err') ? lv : 'info';
  }

  /**
   * 显示时长：没显式给就按字数算。
   * 中文大概每秒读 5~6 个字，这里给得比阅读速度宽松不少 ——
   * 用户可能正看着别处，或者手上拿着手机，宁可多停两秒。
   */
  function durFor(ms, text) {
    if (ms) return ms;
    return Math.max(2600, Math.min(14000, 2200 + text.length * 95));
  }

  // ---------------------------------------------------------------- 存储
  // 读写一律包 try：隐私模式下 localStorage 会直接抛错，
  // 但那只该影响「下次还能不能翻到」，不该让整个提示功能挂掉。

  function readAll() {
    try {
      var raw = global.localStorage.getItem(KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (m) {
        return m && typeof m.m === 'string' && m.m;
      });
    } catch (e) { return []; }
  }

  function writeAll(list) {
    try { global.localStorage.setItem(KEY, JSON.stringify(list)); }
    catch (e) { /* 配额满 / 隐私模式：只影响持久化，当次显示照旧 */ }
  }

  function getReadAt() {
    try { return parseInt(global.localStorage.getItem(READ_KEY), 10) || 0; }
    catch (e) { return 0; }
  }

  function setReadAt(ts) {
    try { global.localStorage.setItem(READ_KEY, String(ts)); }
    catch (e) { /* 同上 */ }
  }

  function unread() {
    var at = getReadAt(), n = 0, list = readAll();
    for (var i = 0; i < list.length; i++) {
      if ((list[i].t || 0) > at) n++;
    }
    return n;
  }

  // ---------------------------------------------------------------- 历史

  /**
   * 只记历史，不弹提示。
   * @returns {object|null} 记下的那条
   */
  function push(level, msg) {
    msg = String(msg == null ? '' : msg).trim();
    if (!msg) return null;
    var item = { t: Date.now(), lv: normLevel(level), m: msg };
    var list = readAll();
    list.unshift(item);
    if (list.length > MAX) list.length = MAX;
    writeAll(list);
    // 面板正开着 = 用户正在看，这条就不算未读
    if (panel) setReadAt(item.t);
    renderBadge();
    if (panel) drawPanel();
    return item;
  }

  function clear() {
    writeAll([]);
    renderBadge();
    if (panel) drawPanel();
  }

  function all() { return readAll(); }

  // ---------------------------------------------------------------- 提示条

  function ensureToast() {
    if (el && el.parentNode) return el;
    el = document.createElement('div');
    el.id = 'gvToast';
    el.className = 'gv-toast';
    el.addEventListener('click', function () { open(); hide(); });
    // 桌面：鼠标停在上面时别收走（用户正在读）
    el.addEventListener('mouseenter', pause);
    el.addEventListener('mouseleave', resume);
    document.body.appendChild(el);
    return el;
  }

  function restart(dur) {
    clearTimeout(timer);
    if (paused) return;
    timer = setTimeout(hide, dur);
  }

  function pause() { paused = true; clearTimeout(timer); }
  function resume() { paused = false; if (showing) restart(el._dur); }

  function render(item) {
    el = ensureToast();
    el.className = 'gv-toast on lv-' + item.lv
      + (item.text.length >= LONG_MSG ? ' hasmore' : '');
    el.textContent = item.text;
    el._dur = item.dur;
    showing = true;
    restart(item.dur);
  }

  function hide() {
    if (!showing) return;
    clearTimeout(timer);
    showing = false;
    paused = false;
    if (el) el.classList.remove('on');
    // 等淡出动画走完再放下一条，避免两条叠在一起闪
    setTimeout(pump, FADE);
  }

  function pump() {
    if (showing || !queue.length) return;
    render(queue.shift());
  }

  /**
   * 弹一条提示（同时记进历史）。
   *
   * @param {string} msg
   * @param {number} [ms]      显示毫秒数，不传则按字数自适应
   * @param {string} [level]   'info' | 'ok' | 'warn' | 'err'
   * @param {object} [opts]
   *        silent  只弹不记历史（进度类提示，弹完就没意义）
   *        replace 覆盖当前这条，不排队（进度类高频更新，排队会越积越多）
   */
  function toast(msg, ms, level, opts) {
    msg = String(msg == null ? '' : msg).trim();
    if (!msg) return null;
    opts = opts || {};
    var lv = normLevel(level);
    var dur = durFor(ms, msg);
    if (!opts.silent) push(lv, msg);
    if (opts.replace && showing) render({ text: msg, dur: dur, lv: lv });
    else { queue.push({ text: msg, dur: dur, lv: lv }); pump(); }
    return msg;
  }

  // ---------------------------------------------------------------- 未读角标

  function renderBadge() {
    var btn = document.getElementById('btnMsg');
    if (!btn) return;
    var old = btn.querySelector('.gv-badge');
    var n = unread();
    if (!n) { if (old) old.remove(); return; }
    if (!old) {
      old = document.createElement('span');
      old.className = 'gv-badge';
      btn.appendChild(old);
    }
    old.textContent = n > 99 ? '99+' : String(n);
  }

  // ---------------------------------------------------------------- 面板

  function drawPanel() {
    if (!panel) return;
    var list = readAll();
    var box = panel.querySelector('.gv-mp-list');
    if (!box) return;
    var keepTop = box.scrollTop <= 2;   // 原本看的就是最新，重绘后还停最新

    panel.querySelector('.gv-mp-count').textContent =
      list.length ? (list.length + ' 条') : '';

    box.innerHTML = list.length
      ? list.map(function (m) {
          return '<div class="gv-mp-item lv-' + normLevel(m.lv) + '">'
            + '<span class="gv-mp-dot"></span>'
            + '<span class="gv-mp-time">' + esc(fmtTime(m.t)) + '</span>'
            // 消息里可能带换行（比如"游戏库没设为公开"那段操作步骤）——
            // 用 pre-wrap 保留，不然挤成一坨没法读。
            + '<span class="gv-mp-text">' + esc(m.m) + '</span>'
            + '</div>';
        }).join('')
      : '<div class="gv-mp-empty">还没有消息。<br>同步、绑定这些操作的结果都会记在这里。</div>';

    if (keepTop) box.scrollTop = 0;
  }

  function open() {
    if (panel) return;
    setReadAt(Date.now());
    renderBadge();
    panel = document.createElement('div');
    panel.id = 'gvMsgPanel';
    panel.className = 'gv-msgpanel';
    panel.innerHTML =
      '<div class="gv-mp-head">'
      + '<span class="gv-mp-title">消息记录</span>'
      + '<span class="gv-mp-count"></span>'
      + '<button class="gv-mp-act" data-a="clear" type="button">清空</button>'
      + '<button class="gv-mp-act" data-a="close" type="button" aria-label="关闭">✕</button>'
      + '</div>'
      + '<div class="gv-mp-list"></div>';
    panel.addEventListener('click', function (e) {
      e.stopPropagation();
      var b = e.target.closest ? e.target.closest('.gv-mp-act') : null;
      if (!b) return;
      if (b.dataset.a === 'clear') {
        if (global.confirm('清空全部消息记录？')) clear();
      } else {
        close();
      }
    });
    document.body.appendChild(panel);
    drawPanel();
    // 延到下一轮事件循环再挂「点外面关闭」——
    // 否则触发本次打开的那个 click 冒到 document 会立刻把它关掉。
    setTimeout(function () {
      document.addEventListener('click', onDocClick);
      document.addEventListener('keydown', onKey);
    }, 0);
  }

  function close() {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKey);
    if (panel) { panel.remove(); panel = null; }
  }

  function onDocClick(e) {
    if (!panel) return;
    var btn = document.getElementById('btnMsg');
    if (btn && btn.contains(e.target)) return;   // 点按钮本身走 toggle
    close();
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function toggle() { panel ? close() : open(); }

  // ---------------------------------------------------------------- 启动

  function init() {
    var btn = document.getElementById('btnMsg');
    if (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggle();
      });
    }
    renderBadge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.GVLog = {
    toast: toast,
    push: push,
    all: all,
    clear: clear,
    unread: unread,
    open: open,
    close: close,
    toggle: toggle,
    // 给测试用：直接看内部状态，比从 DOM 反推可靠
    _debug: {
      queueLen: function () { return queue.length; },
      currentText: function () { return el ? el.textContent : null; },
      currentDur: function () { return el ? el._dur : null; },
      showing: function () { return showing; },
      // 清掉排队与当前显示（不然每条都要等 2.6 秒才轮到下一条，测试跑不完）
      reset: function () {
        queue.length = 0;
        clearTimeout(timer);
        showing = false;
        paused = false;
        if (el) el.classList.remove('on');
      }
    }
  };
})(window);
