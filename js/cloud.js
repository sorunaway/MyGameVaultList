/*
 * GameVault — 云端接入层
 *
 * 职责：
 *   1. 账号（邮箱注册 / 密码登录 / 验证码登录 / 找回密码）
 *   2. Steam 绑定（走服务端的 OpenID，验签在服务端完成）
 *   3. 从 Steam 同步游戏库
 *   4. 把 store.js 的存储层接到云数据库上
 *
 * 关于第 4 点：store.js 里所有业务逻辑（状态归类、合并规则）都是纯内存计算，
 * 只通过 all() / saveMany() / remove() / clear() 四个方法和存储打交道。
 * 所以这里把这四个方法换成云端实现即可，业务规则一行都不用改。
 *
 * 数据隔离是**服务端强制**的：云数据库给每张私有表都开了行级安全策略，
 * 查询和写入只允许命中 owner_id = 当前登录用户 的行。
 * 前端就算改写请求也拿不到别人的数据 —— 这里不做、也不能做安全边界。
 */

(function (global) {
  'use strict';

  const CFG = global.CLOUD_CONFIG || {};
  const DS = global.DataStore;
  const S = DS.STATUS;

  // ⚠️ 这里必须把**所有**会跨会话使用的字段列全。漏一个的后果不是报错，
  // 而是那个字段「本地好好的、一换设备/一刷新就没了」—— 之前 myNote 就踩过
  // （数据库列叫 note，映射漏了，写完就丢），所以新加字段务必同步改三处：
  // OWNER_COLS、rowToGame、gameToRow。
  const OWNER_COLS = 'appid,status,status_manual_at,status_locked,auto_status,' +
    'favorite,note,total_minutes,recent_minutes,last_played_ts,' +
    'ach_earned,ach_total,dismissed_completed,collections,hidden,manual_hidden,' +
    'source,wishlisted,wish_priority,wish_added_ts';

  // Steam 的封面图（header image）URL 有固定规律，能直接按 appid 拼出来。
  // 拿它当兜底，让「商店信息还没补到」的游戏也有封面 —— 零接口开销、零等待。
  // （只用于显示，不写进公共缓存；真封面补到之后自然覆盖它。）
  const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com';

  function cdnHeader(appid) {
    return appid == null ? '' : STEAM_CDN + '/steam/apps/' + appid + '/header.jpg';
  }

  let cloud = null;
  let session = null;
  let profile = null;
  let busy = false;

  // ============================================================
  // 小工具
  // ============================================================
  function q(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  // 提示条归 js/msglog.js 管 —— 它除了显示，还把每条消息记进本机历史
  // （顶栏「消息」按钮可回看），并且会排队显示、按字数给足时间。
  // 这里留一个同名薄封装：调用点不用关心实现，也不会因为模块缺失就把同步搞崩。
  function toast(msg, ms, lv, opts) {
    if (!global.GVLog) { console.warn('msglog.js 未加载，消息无法显示：', msg); return; }
    global.GVLog.toast(msg, ms, lv, opts);
  }

  // ============================================================
  // 样式（自包含，避免和现有 style.css 抢命名）
  // ============================================================
  function injectStyle() {
    if (q('cvStyle')) return;
    const st = document.createElement('style');
    st.id = 'cvStyle';
    st.textContent = [
      '.cv-gate{position:fixed;inset:0;z-index:900;display:flex;align-items:center;',
      'justify-content:center;padding:20px;background:#0f1115;overflow:auto}',
      '.cv-card{width:100%;max-width:400px;background:#171a21;border:1px solid #2a2f3a;',
      'border-radius:14px;padding:26px 22px;color:#e6e8ee;',
      'font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
      '.cv-card h2{margin:0 0 6px;font-size:19px;font-weight:600;color:#fff}',
      '.cv-card p.cv-sub{margin:0 0 18px;font-size:13px;color:#8b93a7}',
      '.cv-brand{font-size:20px;font-weight:600;color:#fff;margin-bottom:8px}',
      '.cv-tabs{display:flex;gap:4px;background:#0f1115;border-radius:9px;padding:4px;margin-bottom:16px}',
      '.cv-tabs button{flex:1;padding:8px 4px;border:0;border-radius:6px;background:transparent;',
      'color:#8b93a7;font-size:13px;cursor:pointer;font-family:inherit}',
      '.cv-tabs button.on{background:#2a3040;color:#fff}',
      '.cv-field{display:block;margin-bottom:12px}',
      '.cv-field span{display:block;font-size:12px;color:#8b93a7;margin-bottom:6px}',
      '.cv-field input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:9px;',
      'border:1px solid #2a2f3a;background:#0f1115;color:#e6e8ee;font-size:15px;',
      'font-family:inherit;outline:none}',
      '.cv-field input:focus{border-color:#4c7dff}',
      '.cv-btn{width:100%;padding:12px;border:0;border-radius:9px;background:#4c7dff;color:#fff;',
      'font-size:15px;font-weight:500;cursor:pointer;font-family:inherit;margin-top:4px}',
      '.cv-btn:disabled{opacity:.55;cursor:default}',
      '.cv-btn.ghost{background:transparent;border:1px solid #2a2f3a;color:#c3c9d6}',
      '.cv-btn.steam{background:#1b2838;border:1px solid #66c0f4;color:#66c0f4;',
      'display:flex;align-items:center;justify-content:center;gap:8px}',
      '.cv-link{display:block;text-align:center;margin-top:14px;font-size:13px;',
      'color:#7f8aa3;cursor:pointer;text-decoration:underline;background:none;border:0;',
      'font-family:inherit;width:100%}',
      '.cv-msg{margin-top:12px;font-size:13px;color:#ff9b9b;min-height:18px;word-break:break-word}',
      '.cv-msg.ok{color:#7ee0a8}',
      '.cv-hint{margin-top:14px;font-size:12px;color:#69718a;line-height:1.65}',
      '.cv-hint b{color:#98a2b8;font-weight:500}',
      '.cv-hint code{background:#232833;padding:1px 5px;border-radius:4px;',
      'font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:#a9b4cc}',
      '.cv-or{margin:14px 0;text-align:center;font-size:12px;color:#5b6376}',
      // 授权失败原因：钉在卡片上，别只靠 toast（一闪就没了）
      '.cv-alert{margin:0 0 14px;padding:11px 13px;border-radius:10px;text-align:left;',
      'background:#3a2028;border:1px solid #7d3b47;color:#ffc9d2;',
      'font-size:12.5px;line-height:1.6}',
      '.cv-alert b{display:block;margin-bottom:3px;color:#ff9fb0;font-size:13px}',
      '.cv-code{font-family:ui-monospace,Consolas,monospace;letter-spacing:3px;text-align:center}',
      '.cv-avatar{width:22px;height:22px;border-radius:50%;vertical-align:-5px;margin-right:6px}',
      '.cv-menu{position:fixed;right:14px;top:58px;z-index:880;background:#171a21;',
      'border:1px solid #2a2f3a;border-radius:11px;padding:6px;min-width:210px;',
      'box-shadow:0 10px 34px rgba(0,0,0,.5);color:#e6e8ee;',
      'font:13px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif}',
      '.cv-menu .cv-mi{display:flex;align-items:center;gap:8px;padding:10px 11px;',
      'border-radius:7px;cursor:pointer;white-space:nowrap}',
      '.cv-menu .cv-mi:hover{background:#232836}',
      '.cv-menu .cv-sep{height:1px;background:#2a2f3a;margin:5px 3px}',
      '.cv-menu .cv-id{font-size:11px;color:#69718a;padding:4px 11px 6px;word-break:break-all}',
      '@media(max-width:560px){.cv-card{padding:22px 18px}.cv-menu{left:14px;right:14px}}'
    ].join('');
    document.head.appendChild(st);
  }

  // ============================================================
  // 登录 / 注册界面
  // ============================================================
  let gateMode = 'login';

  function hideGate(id) {
    const el = q(id);
    if (el) el.remove();
  }

  function showGate(mode) {
    // 切 tab 会把整块 DOM 重建，先把已填的抓下来，重建后回填。
    // 最常走的一条路是「密码登录 → 忘记密码？」，邮箱得跟过去，
    // 否则用户刚敲完的邮箱要再输一遍。验证码不回填 —— 它是一次性的，
    // 切过去本来就要重点「发送验证码」。
    const prevEmail = (q('cvEmail') || {}).value || '';
    const prevPwd = (q('cvPwd') || {}).value || '';
    gateMode = mode || 'login';
    injectStyle();
    hideGate('cvGate');
    const box = document.createElement('div');
    box.id = 'cvGate';
    box.className = 'cv-gate';
    box.innerHTML = gateHTML();
    document.body.appendChild(box);
    bindGate();
    const em = q('cvEmail');
    if (em && !em.value) em.value = prevEmail;
    const pw = q('cvPwd');
    if (pw && !pw.value) pw.value = prevPwd;
    // 已经填过邮箱就别再把光标丢回邮箱框，直接落到下一个待填项
    const inputs = box.querySelectorAll('input');
    const target = (inputs[0] && inputs[0].value)
      ? (inputs[1] || inputs[0]) : inputs[0];
    if (target) target.focus();
  }

  function gateHTML() {
    const m = gateMode;
    const tabs = [
      ['login', '密码登录'], ['otp', '验证码登录'], ['signup', '注册']
    ].map(function (t) {
      return '<button data-m="' + t[0] + '" class="' + (m === t[0] ? 'on' : '') + '">'
        + t[1] + '</button>';
    }).join('');

    let body = '';
    if (m === 'otp') {
      body = '<label class="cv-field"><span>邮箱</span>'
        + '<input id="cvEmail" type="email" autocomplete="email" placeholder="you@example.com"></label>'
        + '<label class="cv-field"><span>验证码（点下面的按钮发到邮箱）</span>'
        + '<input id="cvCode" class="cv-code" type="text" inputmode="numeric" '
        + 'placeholder="6 位数字"></label>'
        + '<button class="cv-btn" id="cvGo">登录 / 注册</button>'
        + '<button class="cv-btn ghost" id="cvSend" style="margin-top:8px">发送验证码</button>'
        + '<div class="cv-msg" id="cvMsg"></div>';
    } else if (m === 'signup') {
      body = '<label class="cv-field"><span>邮箱</span>'
        + '<input id="cvEmail" type="email" autocomplete="email" placeholder="you@example.com"></label>'
        + '<label class="cv-field"><span>验证码（点下面的按钮发到邮箱）</span>'
        + '<input id="cvCode" class="cv-code" type="text" inputmode="numeric" placeholder="6 位数字"></label>'
        + '<label class="cv-field"><span>设置密码（至少 8 位）</span>'
        + '<input id="cvPwd" type="password" autocomplete="new-password" placeholder="********"></label>'
        + '<button class="cv-btn" id="cvGo">注册并登录</button>'
        + '<button class="cv-btn ghost" id="cvSend" style="margin-top:8px">发送验证码</button>'
        + '<div class="cv-msg" id="cvMsg"></div>';
    } else if (m === 'reset') {
      body = '<label class="cv-field"><span>邮箱</span>'
        + '<input id="cvEmail" type="email" autocomplete="email"></label>'
        + '<label class="cv-field"><span>邮件里的验证码</span>'
        + '<input id="cvCode" class="cv-code" type="text" inputmode="numeric"></label>'
        + '<label class="cv-field"><span>新密码</span>'
        + '<input id="cvPwd" type="password" autocomplete="new-password"></label>'
        + '<button class="cv-btn" id="cvGo">重设密码</button>'
        + '<button class="cv-btn ghost" id="cvSend" style="margin-top:8px">发送验证码</button>'
        + '<div class="cv-msg" id="cvMsg"></div>';
    } else {
      body = '<label class="cv-field"><span>邮箱</span>'
        + '<input id="cvEmail" type="email" autocomplete="email" placeholder="you@example.com"></label>'
        + '<label class="cv-field"><span>密码</span>'
        + '<input id="cvPwd" type="password" autocomplete="current-password" placeholder="********"></label>'
        + '<button class="cv-btn" id="cvGo">登录</button>'
        + '<div class="cv-msg" id="cvMsg"></div>'
        + '<button class="cv-link" id="cvForgot">忘记密码？</button>';
    }

    return '<div class="cv-card">'
      + '<div class="cv-brand">◈ 我的游戏生涯</div>'
      + '<p class="cv-sub">登录后进度存在云端，换手机、清缓存都不会丢</p>'
      + '<div class="cv-tabs">' + tabs + '</div>'
      + body
      + '<div class="cv-hint">用邮箱注册即可。你的游戏数据只属于这个账号，'
      + '别人看不到，你也看不到别人的。</div>'
      + '</div>';
  }

  function setMsg(text, ok) {
    const el = q('cvMsg');
    if (el) { el.textContent = text || ''; el.className = 'cv-msg' + (ok ? ' ok' : ''); }
  }

  function busyBtn(id, on, label) {
    const b = q(id);
    if (!b) return;
    // 进 busy 前先把按钮原本的文字存下来。不存的话，重置时
    // dataset.label 是 undefined，会退化成「保留当前文字」——
    // 于是按钮永远停在「处理中…」，看着像还在转。
    if (on && !b.dataset.label) b.dataset.label = b.textContent;
    b.disabled = !!on;
    if (label) b.textContent = label;
    else if (!on) b.textContent = b.dataset.label || b.textContent;
  }

  function bindGate() {
    const box = q('cvGate');
    if (!box) return;
    box.querySelectorAll('.cv-tabs button').forEach(function (b) {
      b.addEventListener('click', function () { showGate(b.dataset.m); });
    });
    const forgot = q('cvForgot');
    if (forgot) forgot.addEventListener('click', function () { showGate('reset'); });

    const send = q('cvSend');
    if (send) send.addEventListener('click', onSendCode);

    const go = q('cvGo');
    if (go) go.addEventListener('click', onSubmit);

    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); onSubmit(); }
    });
  }

  async function onSendCode() {
    const email = (q('cvEmail') || {}).value;
    if (!email) { setMsg('请先填邮箱'); return; }
    const send = q('cvSend');          // 发送句柄挂在这个按钮上，供 onSubmit 复用
    busyBtn('cvSend', true, '发送中…');
    try {
      if (gateMode === 'reset') {
        const r = await cloud.auth.resetPasswordForEmail(email);
        if (r.error) throw r.error;
        // 复用这次找回流程的句柄。提交时若再调一次 resetPasswordForEmail，
        // 会重新发一封邮件，把用户手里那封的验证码顶掉，于是「怎么填都错」。
        send._recover = r.data;
      } else {
        const r = await cloud.auth.sendOtp({ email: email });
        if (r.error) throw r.error;
        send._vid = r.data.verificationId;
        send._exist = r.data.isExistingUser;
      }
      setMsg('验证码已发到你邮箱，5 分钟内有效', true);
      busyBtn('cvSend', false, '重新发送');
    } catch (e) {
      setMsg(friendly(e));
      busyBtn('cvSend', false, '发送验证码');
    }
  }

  async function onSubmit() {
    const email = (q('cvEmail') || {}).value || '';
    const pwd = (q('cvPwd') || {}).value || '';
    const code = (q('cvCode') || {}).value || '';
    const send = q('cvSend');
    if (!email) { setMsg('请填邮箱'); return; }
    // ⚠️ 「要不要验证码」必须按模式判断，不能所有模式一起卡。
    //    密码登录界面上**根本没有** #cvCode 这个输入框（见 gateHTML），
    //    所以这里若无条件地要求 code 非空，code 恒为 '' → 点多少次登录
    //    都只会得到「请填邮件里的验证码」，而屏幕上压根没有能填的地方。
    const needCode = (gateMode === 'otp' || gateMode === 'signup' || gateMode === 'reset');
    if (needCode && !code) { setMsg('请填邮件里的验证码'); return; }
    if (!pwd && gateMode !== 'otp') {
      setMsg(gateMode === 'login' ? '请填密码' : '请填新密码');
      return;
    }

    busyBtn('cvGo', true, '处理中…');
    setMsg('');
    try {
      let r;
      if (gateMode === 'login') {
        r = await cloud.auth.signInWithPassword({ email: email, password: pwd });
        if (r.error) throw r.error;
      } else if (gateMode === 'otp') {
        // 必须复用「发送验证码」那一步拿到的 challenge。
        // 这里如果再调一次 signInWithOtp，会重发一封、把旧验证码作废 ——
        // 表现就是"明明填的是刚收到的码，却一直说不对"。
        const vid = send && send._vid;
        if (!vid) throw new Error('请先点「发送验证码」');
        r = await cloud.auth.verifyOtp({
          verificationId: vid,
          token: code,
          email: email,
          isExistingUser: send._exist
        });
        if (r.error) throw r.error;
      } else if (gateMode === 'signup') {
        if (pwd.length < 8) throw new Error('密码至少 8 位');
        const vid = send && send._vid;
        if (!vid) throw new Error('请先点「发送验证码」');
        r = await cloud.auth.verifyOtp({
          verificationId: vid,
          token: code,
          email: email,
          isExistingUser: send._exist,
          password: send._exist ? undefined : pwd
        });
        if (r.error) throw r.error;
      } else if (gateMode === 'reset') {
        if (pwd.length < 8) throw new Error('新密码至少 8 位');
        const rec = send && send._recover;
        if (!rec) throw new Error('请先点「发送验证码」');
        r = await rec.updateUser({ nonce: code, password: pwd });
        if (r.error) throw r.error;
      }
      await afterLogin();
    } catch (e) {
      setMsg(friendly(e));
      busyBtn('cvGo', false);
    }
  }

  function friendly(e) {
    const k = (e && (e.kind || e.code)) || '';
    const m = (e && e.message) || String(e || '出错了');
    if (/invalid_grant|unauthenticated/i.test(k + m)) {
      // 同一类错误在不同 tab 下意思完全不同，别给一句通用话术：
      // 密码登录报这个，最常见的原因不是「密码打错了」，而是**这个账号
      // 压根没设过密码**（用验证码登录直接创建的账号就没有密码）。
      // 直接告诉他下一步往哪走，省得反复试密码。
      if (gateMode === 'login') {
        return '账号或密码不对。如果这个邮箱没设过密码，请点上面的「验证码登录」，'
          + '或点下面的「忘记密码？」设一个';
      }
      return '验证码不对或已经过期，请重新点「发送验证码」';
    }
    if (/network|backend-unavailable/i.test(k + m)) return '网络不稳，请稍后再试';
    if (/already|23505/i.test(m)) return '这个邮箱已经注册过了，直接登录吧';
    if (/rate|too many/i.test(m)) return '操作太频繁，等一会儿再试';
    return m;
  }

  // ============================================================
  // 登录之后：读档案 -> 没绑 Steam 就先绑
  // ============================================================
  async function afterLogin() {
    hideGate('cvGate');
    await loadProfile();
    if (!profile || !profile.steam_id) {
      showBind();
      return false;
    }
    hideGate('cvBind');
    patchDataStore();
    takeoverUI();
    renderWho();
    await refreshApp();
    return true;
  }

  /**
   * 刷新界面：由 ui.js 在启动末尾挂上 __gvRefresh 钩子。
   * 在登录刚完成时它可能还没挂上，那时是空操作 —— 因为 boot() 会接着往下跑。
   */
  async function refreshApp() {
    if (global.__gvRefresh) await global.__gvRefresh();
  }

  async function loadProfile() {
    const { data, error } = await cloud.database
      .from('profiles').select('*').limit(1).maybeSingle();
    if (error) { console.warn('读档案失败', error); profile = null; return; }
    profile = data || null;
  }

  function showBind() {
    injectStyle();
    hideGate('cvBind');

    // 上次授权失败的话，把原因钉在卡片上 —— 光靠 toast 用户会错过
    let errHtml = '';
    if (lastSteamError) {
      const tip = STEAM_ERR_TIPS[lastSteamError] || STEAM_ERR_TIPS.verify;
      errHtml = '<div class="cv-alert"><b>' + esc(tip.t) + '</b>'
        + '<span>' + esc(tip.d) + '</span></div>';
    }

    const box = document.createElement('div');
    box.id = 'cvBind';
    box.className = 'cv-gate';
    box.innerHTML = '<div class="cv-card">'
      + '<h2>绑定你的 Steam 账号</h2>'
      + '<p class="cv-sub">绑定后会自动读取你的游戏库、时长和成就</p>'
      + errHtml
      + '<label class="cv-field"><span>Steam ID 或个人资料链接</span>'
      + '<input id="cvSteamInput" type="text" autocomplete="off" spellcheck="false" '
      + 'placeholder="7656119… 或个人资料页链接"></label>'
      + '<button class="cv-btn" id="cvBindManual">绑定</button>'
      + '<div class="cv-msg" id="cvMsg"></div>'
      + '<div class="cv-hint">'
      + '<b>在哪找：</b>Steam 客户端 → 点头像 → 查看我的个人资料，'
      + '地址栏里 <code>profiles/数字</code> 或 <code>id/名字</code> 那段就是；'
      + '把整条链接粘进来也能识别。<br>'
      + '⚠️ 需要先把「隐私设置」里的<b>游戏详情</b>设为公开，否则读不到游戏库。'
      + '</div>'
      + '<div class="cv-or"><span>或者</span></div>'
      + '<button class="cv-btn ghost" id="cvBindBtn">用 Steam 授权登录</button>'
      + '<button class="cv-link" id="cvSignOut">退出当前账号</button>'
      + '</div>';
    document.body.appendChild(box);
    q('cvBindManual').addEventListener('click', bindManual);
    const inp = q('cvSteamInput');
    if (inp) {
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') bindManual();
      });
      inp.focus();
    }
    q('cvBindBtn').addEventListener('click', function () {
      location.href = '/auth/steam/start';
    });
    q('cvSignOut').addEventListener('click', signOut);
  }

  // ===== Steam 授权失败的原因说明 =====
  //
  // 服务端把失败原因细化后放在 ?steam_error= 里带回来，这里翻译成人话。
  // ⚠️ 最关键的是 network 这条：它是**服务端出网问题**，和用户操作无关，
  //    不区分出来的话，用户会一直以为是自己点错了，反复重试。
  const STEAM_ERR_TIPS = {
    state: {
      t: '授权等待超时',
      d: '授权票据有效期 30 分钟。你在 Steam 那边停留太久或中途退出了，重新点一次「使用 Steam 登录」就行。'
    },
    no_params: {
      t: '没收到授权信息',
      d: '这次跳转没带上 Steam 的授权数据，重新点一次「使用 Steam 登录」。'
    },
    network: {
      t: '本站服务器连不上 Steam',
      d: '本站服务器访问不了 steamcommunity.com（这个域名在国内被拦截），'
       + '拿不到授权校验结果 —— 不是你的账号问题，反复重试也没用。'
    },
    invalid: {
      t: 'Steam 拒绝了这次授权',
      d: '可能是授权票据过期了，重新点一次「使用 Steam 登录」。'
    },
    no_id: {
      t: '授权信息不完整',
      d: '没能从 Steam 的回复里读出账号 ID，请重新试一次。'
    },
    verify: {
      t: 'Steam 授权没通过',
      d: '请重新点一次「使用 Steam 登录」。'
    }
  };

  // 上次授权失败的原因。URL 参数会被 replaceState 清掉，所以落地时立刻存下来，
  // 好在绑定卡片里持续显示（toast 一闪就没了，用户很容易错过）。
  let lastSteamError = '';

  /** 处理从 Steam 回调回来的结果（服务端已验签） */
  async function handleSteamCallback() {
    let steamid = '';
    try {
      const sp = new URLSearchParams(location.search);
      steamid = sp.get('steam_bound') || '';
      const err = sp.get('steam_error');
      // 清掉地址栏参数，避免刷新时重复处理
      const clean = location.pathname + (sp.get('view') ? '?view=' + sp.get('view') : '');
      history.replaceState(null, '', clean);
      if (err) {
        lastSteamError = err;
        const tip = STEAM_ERR_TIPS[err] || STEAM_ERR_TIPS.verify;
        toast(tip.t + '：' + tip.d, 10000, 'err');
        return;
      }
    } catch (e) { return; }
    if (!steamid) return;

    try {
      const info = await apiGet('/api/steam/player?steamid=' + encodeURIComponent(steamid));
      await saveBinding(steamid, info.player || {});
      lastSteamError = '';
      toast('Steam 账号已绑定：' + ((info.player && info.player.name) || steamid), null, 'ok');
    } catch (e) {
      console.warn(e);
      toast('绑定信息保存失败，请刷新重试', null, 'err');
    }
  }

  /** 把 Steam 账号写进当前用户档案（授权登录 / 手填 ID 两条通路共用） */
  async function saveBinding(steamid, player) {
    const patch = {
      steam_id: steamid,
      persona: (player && player.name) || '',
      avatar: (player && player.avatar) || ''
    };
    const { error } = await cloud.database.from('profiles')
      .upsert(patch, { onConflict: 'owner_id' });
    if (error) throw error;
    await loadProfile();
  }

  /**
   * 手动绑定：把用户填的 Steam ID / 个人资料链接交给服务端解析。
   *
   * 为什么必须有这条路：Steam 授权（OpenID）的验签必须请求
   * steamcommunity.com，而它国内被拦截 —— 服务端连不上就没法完成验签，
   * 用户点多少次都是白点。这条路只走 api.steampowered.com（国内可达），
   * 所以能稳定绑上。
   */
  async function bindManual() {
    const el = q('cvSteamInput');
    const raw = ((el && el.value) || '').trim();
    if (!raw) { setMsg('请先填写 Steam ID 或个人资料链接'); return; }
    busyBtn('cvBindManual', true, '查询中…');
    setMsg('');
    try {
      const d = await apiGet('/api/steam/resolve?q=' + encodeURIComponent(raw));
      if (d && d.error) throw new Error(d.message || '没找到这个账号');
      if (!d || !d.steamid) throw new Error('没找到这个账号');
      await saveBinding(d.steamid, d.player || {});
      lastSteamError = '';
      toast('已绑定：' + ((d.player && d.player.name) || d.steamid), null, 'ok');
      hideGate('cvBind');
      await afterLogin();
    } catch (e) {
      setMsg(friendly(e));
      busyBtn('cvBindManual', false, '绑定');
    }
  }

  // ============================================================
  // 数据访问
  // ============================================================
  async function apiGet(path) {
    const headers = {};
    try {
      const t = await cloud.auth.getAccessToken();
      if (t) headers.Authorization = 'Bearer ' + t;
    } catch (e) { /* 后端目前不强制要求 */ }
    const r = await fetch(path, { headers: headers });
    const d = await r.json().catch(function () { return {}; });
    if (!r.ok && !d.error) throw new Error('请求失败（' + r.status + '）');
    return d;
  }

  async function selectAll(table, cols) {
    const out = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await cloud.database.from(table)
        .select(cols).range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || !data.length) break;
      out.push.apply(out, data);
      if (data.length < PAGE) break;
    }
    return out;
  }

  async function loadMeta(appids) {
    const map = {};
    const ids = appids.filter(function (a) { return a != null; });
    for (const part of chunk(ids, 80)) {
      const { data, error } = await cloud.database.from('game_meta')
        .select('*').in('appid', part);
      if (error) { console.warn('读公共信息失败', error); continue; }
      (data || []).forEach(function (m) { map[m.appid] = m; });
    }
    return map;
  }

  function isoToTs(v) {
    if (!v) return null;
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }

  function rowToGame(r, m) {
    m = m || {};
    // 成就字段的三种状态（决定同步时要不要再去问 Steam）：
    //   ach_total 为 null -> 这款游戏的成就进度还没查过
    //   ach_total 为 0    -> 查过了，这款游戏压根没有成就系统
    //   ach_total 大于 0  -> 真实成就总数，配 ach_earned 用
    // 用 0 而不是空对象来表示「没有成就」，是为了下次同步能自动跳过它，
    // 不会每次都去问一遍同样没有成就的游戏（那会白烧 Steam 的调用额度）。
    let ach = null;
    if (r.ach_total != null) {
      ach = r.ach_total > 0
        ? { earned: r.ach_earned || 0, total: r.ach_total }
        : { earned: 0, total: 0 };
    }
    return {
      id: 'g_' + r.appid,
      appid: r.appid,
      title: m.title || ('App ' + r.appid),
      icon: m.icon || '',
      // 没有真封面就按 appid 拼一个 CDN 地址顶上（图片挂了会走 onerror 占位图）
      header: m.header || cdnHeader(r.appid),
      releaseYear: m.release_year == null ? null : m.release_year,
      releaseDate: m.release_date || '',
      genres: m.genres || [],
      developers: m.developers || [],
      collections: r.collections || [],
      totalMinutes: r.total_minutes || 0,
      recentMinutes: r.recent_minutes || 0,
      lastPlayedTs: r.last_played_ts || 0,
      achievements: ach,
      status: r.status || S.LIBRARY,
      // manualStatus 是「手动优先」规则的依据（mergeSteam 会比对它和最后启动时间）。
      // 库里没有单独的列，但 status_manual_at 有值就说明这个 status 是用户手选的，
      // 所以直接由它反推 —— 少了这一步，云端模式下用户手动改的状态会被自动规则悄悄改回去。
      manualStatus: r.status_manual_at ? (r.status || null) : null,
      statusManualAt: isoToTs(r.status_manual_at),
      statusLocked: !!r.status_locked,
      autoStatus: !!r.auto_status,
      favorite: !!r.favorite,
      // 界面读写的字段叫 myNote（手写感想），数据库列名叫 note，这里做一次映射。
      // 之前漏了这层映射，导致云端模式下「我的游玩记录」写完就丢。
      myNote: r.note || '',
      hidden: !!r.hidden,
      manualHidden: !!r.manual_hidden,
      dismissedCollection: !!r.dismissed_completed,
      steamReview: '',
      // 「已拥有 / 未入库」角标的依据。以前这里硬编码 'steam'，于是愿望单游戏
      // 在云端模式下会**丢掉身份、被当成已拥有** —— 所以数据库加了 source 列。
      // 老行没有这个值（null）时按 'steam' 处理：加这列之前库里只可能有 Steam 游戏。
      source: r.source || 'steam',
      wishlisted: !!r.wishlisted,
      wishPriority: r.wish_priority || 0,
      wishAddedTs: r.wish_added_ts || 0
    };
  }

  function gameToRow(g) {
    return {
      appid: g.appid,
      status: g.status || S.LIBRARY,
      status_manual_at: g.statusManualAt ? new Date(g.statusManualAt).toISOString() : null,
      status_locked: !!g.statusLocked,
      auto_status: !!g.autoStatus,
      favorite: !!g.favorite,
      note: g.myNote || '',
      total_minutes: g.totalMinutes || 0,
      recent_minutes: g.recentMinutes || 0,
      last_played_ts: g.lastPlayedTs || 0,
      ach_earned: g.achievements ? (g.achievements.earned || 0) : null,
      ach_total: g.achievements ? (g.achievements.total || 0) : null,
      dismissed_completed: !!g.dismissedCollection,
      collections: Array.isArray(g.collections) ? g.collections : [],
      hidden: !!g.hidden,
      manual_hidden: !!g.manualHidden,
      source: g.source || 'manual',
      wishlisted: !!g.wishlisted,
      wish_priority: g.wishPriority || 0,
      wish_added_ts: g.wishAddedTs || 0
    };
  }

  /**
   * user_games 里的一条记录 -> game_meta 的一行。
   *
   * ⚠️ 只写「真的知道」的字段，**绝不用 null 去覆盖**。
   * game_meta 是全站共享的公共缓存，写一行 null 等于把别人（或自己）早先
   * 存好的游戏名/封面抹掉。最典型的踩法：成就扫描只带 {appid, achievements}
   * 调 mergeSteam，顺手回写一行 title=null —— 那款游戏的名字就没了，
   * 界面上退化成「App 320」，而且它看起来「已经缓存过」，再也不会被补回来。
   *
   * 键不一致的问题由 groupByShape() 解决：PostgREST 的批量 upsert
   * 要求同一批里每行的键完全一致，所以按键集合分组再分别提交。
   */
  function gameToMeta(g) {
    const row = { appid: g.appid };
    if (g.title) row.title = g.title;
    if (g.header) row.header = g.header;
    if (g.icon) row.icon = g.icon;
    if (g.releaseYear != null) row.release_year = g.releaseYear;
    if (g.releaseDate) row.release_date = g.releaseDate;
    if (Array.isArray(g.genres) && g.genres.length) row.genres = g.genres;
    if (Array.isArray(g.developers) && g.developers.length) row.developers = g.developers;
    return row;
  }

  /** 按「键集合」把行分组 —— PostgREST 批量 upsert 要求同批每行键一致。 */
  function groupByShape(rows) {
    const map = new Map();
    rows.forEach(function (r) {
      const k = Object.keys(r).sort().join(',');
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    });
    return Array.from(map.values());
  }

  // ============================================================
  // 存储层替换
  // ============================================================
  async function cloudAll() {
    const rows = await selectAll('user_games', OWNER_COLS);
    if (!rows.length) return [];
    const metas = await loadMeta(rows.map(function (r) { return r.appid; }));
    return rows.map(function (r) { return rowToGame(r, metas[r.appid]); });
  }

  async function cloudSaveMany(list) {
    if (!list || !list.length) return;
    const rows = list.filter(function (g) { return g.appid != null; }).map(gameToRow);
    for (const part of chunk(rows, 120)) {
      const { error } = await cloud.database.from('user_games')
        .upsert(part, { onConflict: 'owner_id,appid' });
      if (error) throw error;
    }
    // 公共信息（谁都能读，用来省 Steam 接口调用）
    const metas = list.filter(function (g) { return g.appid != null; }).map(gameToMeta);
    for (const group of groupByShape(metas)) {
      for (const part of chunk(group, 120)) {
        const { error } = await cloud.database.from('game_meta')
          .upsert(part, { onConflict: 'appid' });
        if (error) console.warn('写公共信息失败（不影响进度）', error);
      }
    }
  }

  async function cloudRemove(id) {
    const appid = String(id || '').replace(/^g_/, '');
    if (!/^\d+$/.test(appid)) return;
    const { error } = await cloud.database.from('user_games')
      .delete().eq('appid', Number(appid));
    if (error) throw error;
  }

  async function cloudClear() {
    // 不写 WHERE 条件不行，但这里给一个恒真条件，真正的边界由服务端 RLS 兜住：
    // 无论条件怎么写，都只可能删到自己的行。
    const { error } = await cloud.database.from('user_games').delete().gte('id', 0);
    if (error) throw error;
  }

  function patchDataStore() {
    DS.all = cloudAll;
    DS.saveMany = cloudSaveMany;
    DS.save = async function (g) { g.updatedAt = Date.now(); return cloudSaveMany([g]); };
    DS.remove = cloudRemove;
    DS.clear = cloudClear;
    DS.probe = async function () { return 'cloud'; };
    // 让底部状态栏说真话（ui.js 会读这个值）。
    // 默认文案是「数据保存在本机浏览器」，云端模式下不能那么写。
    global.__gvStorageNote = '进度已存在云端，换设备登录就能看到';
  }

  // ============================================================
  // Steam 同步
  // ============================================================
  // ============================================================
  // 愿望单同步（Steam 愿望单 -> 「我的游戏单」+「待游玩」）
  // ============================================================
  /**
   * 拉一次 Steam 愿望单，合并进本地库。
   *
   * 结果长这样：新款的 status = backlog（→ 进「待游玩」），source = 'wishlist'
   * （→ 「我的游戏单」里挂「未入库」角标）；库里已有的只补愿望单身份，不动状态。
   *
   * 返回 { ok, count, added, removed, kept, appids } 或 { ok:false, reason, message }。
   * 调用方**不需要**在失败时做任何补偿 —— 这个函数自己保证失败即无副作用。
   *
   * ## 🔴 空列表守卫（整个功能里最要紧的一段）
   *
   * `DS.mergeWishlist` 会把「本地有、这次没返回」的款判定成「你把它从愿望单
   * 删掉了」，删掉记录。而下面这两种情况返回的东西**完全一样**：
   *   · 愿望单真的空了
   *   · 隐私设置没公开（Steam 对空和未公开给的是同一份 `{"response":{}}`）
   * 一次误判就是几百条记录没了，且不可恢复。所以：
   *   · 接口失败 / 状态不可用 / 结果为空  -> **一律不调 mergeWishlist**，什么都不做
   * 宁可这次不导入，也不能猜。
   */
  async function syncWishlist() {
    let d = null;
    try {
      d = await apiGet('/api/steam/wishlist?steamid=' + profile.steam_id);
    } catch (e) {
      return { ok: false, reason: 'network',
               message: '愿望单这次没拉到（网络问题），下次同步会自动重来。' };
    }
    if (!d || d.error) {
      return { ok: false, reason: (d && d.error) || 'network',
               message: (d && d.message) || '愿望单这次没拉到，下次同步会自动重来。' };
    }
    if (d.state === 'unavailable') {
      return { ok: false, reason: 'unavailable', message: d.message || '',
               howToFix: d.howToFix || [] };
    }

    const items = (d.items || []).filter(function (x) { return x && x.appid; });
    if (!items.length) {
      return { ok: false, reason: 'empty',
               message: '愿望单这次返回的是空的，已跳过（不做任何删除）。' };
    }

    const stat = await DS.mergeWishlist(items);
    return {
      ok: true,
      count: items.length,
      added: stat.added,
      removed: stat.removed,
      kept: stat.kept,
      appids: items.map(function (x) { return x.appid; })
    };
  }

  async function syncNow(btn) {
    if (busy) return;
    if (!profile || !profile.steam_id) { showBind(); return; }
    busy = true;
    const old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
    try {
      const d = await apiGet('/api/steam/library?steamid=' + profile.steam_id);
      if (d.error === 'profile_private') {
        const steps = '读不到你的游戏库。\n\n原因：Steam 的「游戏详情」没有设为公开。\n\n'
          + (d.howToFix || []).map(function (s, i) { return (i + 1) + '. ' + s; }).join('\n');
        // 这段是「照着做就能修好」的操作步骤，继续用弹窗（会停在屏幕上等人读完），
        // 但也记进历史 —— 关掉弹窗之后还能翻回来照着做。
        if (global.GVLog) global.GVLog.push('err', steps);
        alert(steps);
        return;
      }
      if (d.error) throw new Error(d.message || d.error);
      if (d.stale) toast(d.message || '这次没连上 Steam，显示的是上次同步的结果', null, 'warn');

      const games = d.games || [];
      if (!games.length) { toast('Steam 返回的游戏库是空的', null, 'warn'); return; }
      // 服务端在链路抽风时会走降级路径：游戏和时长都拿到了，但 Steam 没给名称。
      // 这时**必须说清楚**，否则用户看到一堆「App 220」会以为数据坏了。
      // （名称会在下次同步或补封面时回来 —— 已有的名字不会被空值覆盖。）
      if (d.namesOk === false) {
        toast('这次只取到游戏和时长，名称暂缺；过一会儿再同步一次就会补上', null, 'warn');
      }

      // ===== 合并前先拍一张快照 =====
      // 用来判断「这次哪些游戏被启动过」—— 必须在 mergeSteam 之前读，
      // 合并之后旧时长就被新时长盖掉、再也比不出来了。
      let before = [];
      try { before = await DS.all(); } catch (e) { console.warn('读旧数据失败', e); }
      const prevMinutes = new Map();
      before.forEach(function (g) {
        if (g.appid != null) prevMinutes.set(String(g.appid), g.totalMinutes || 0);
      });

      // 时长涨了 = 这段时间启动过这个游戏（Steam 的时长只增不减）。
      //
      // 这就是「只看最近打开过的游戏」的精确实现 —— 而且比时间窗口更可靠：
      // 不依赖任何「最近 N 天」的窗口，两次同步隔了三天还是三个月都不会漏。
      // 重扫成就只需要这一份名单，判定成本是零（时长就在本来要拉的库响应里）。
      const touched = new Set();
      games.forEach(function (g) {
        const k = String(g.appid);
        if (!prevMinutes.has(k)) return;   // 新游戏交给「成就还是空白」那条规则
        if ((g.totalMinutes || 0) > prevMinutes.get(k)) touched.add(k);
      });

      const metas = await loadMeta(games.map(function (g) { return g.appid; }));
      const incoming = games.map(function (g) {
        const m = metas[g.appid] || {};
        return {
          appid: g.appid,
          // 逐级兜底：库里的名字 -> 公共缓存里的名字 -> 留空。
          // 留空是安全的，但绝不能拿空值去覆盖缓存。
          // ⚠️ 别指望界面替你把名字补上：cardHtml 直接渲染 title，没有 appid 兜底
          // （这行注释以前说「界面会按 appid 兜底显示」，2026-09-20 复核是错的）。
          // 所以愿望单来的款在补全之前，卡面就是空标题 + ◈ 占位图。
          title: g.title || m.title || '',
          icon: g.icon || m.icon || '',
          header: m.header || '',
          releaseYear: m.release_year == null ? null : m.release_year,
          releaseDate: m.release_date || '',
          genres: m.genres || [],
          developers: m.developers || [],
          totalMinutes: g.totalMinutes,
          recentMinutes: g.recentMinutes,
          lastPlayedTs: g.lastPlayedTs,
          achievements: null,
          collections: []
        };
      });

      // 走原有的合并规则（状态归类、锁定、放弃区全部复用）
      const stat = await DS.mergeSteam(incoming);

      // ===== 愿望单：合并进「我的游戏单」+「待游玩」 =====
      // 排在 refreshApp 之前，让这一屏就能看到新导入的款。
      // 失败不影响本次同步 —— 库已经落库了，愿望单下次再来。
      let wishStat = null;
      try {
        wishStat = await syncWishlist();
      } catch (e) { console.warn('愿望单同步中断，本次同步继续', e); }

      const patch = {
        persona: (d.player && d.player.name) || profile.persona || '',
        avatar: (d.player && d.player.avatar) || profile.avatar || '',
        last_sync: new Date().toISOString()
      };
      await cloud.database.from('profiles').upsert(patch, { onConflict: 'owner_id' });
      await loadProfile();
      renderWho();

      // ⚠️ 顺序很关键：**先合并 + 刷新界面，再做补封面和核对成就**。
      // 这两件事都慢（补封面要一款一款问商店，核对成就要一款一款问成就），
      // 放在前面的话，用户要对着空列表等好几分钟 —— 手机浏览器还会直接
      // 把后台标签页冻死，整个同步就此半途而废。
      // 现在库已经落库了，后面两步哪怕被中断也不影响「游戏能看到」，
      // 而且都是可续传的，下次同步自动接着跑。
      await refreshApp();
      toast('已同步 ' + games.length + ' 款，正在补封面和核对成就…', null, 'info');

      // 补公共信息（封面 / 发售年 / 类型）。顺序有讲究：
      //   ① **愿望单来的款排最前面** —— 它们连名字都还没有（愿望单接口只给
      //      appid），卡面上会退化成「App 1888930」，最需要先把信息补上。
      //   ② 然后是库里的，按游玩时长从多到少 —— 玩得多的更可能被点开看。
      // 新增款也天然靠前：fillMeta 只看「还没补过的」，老款早补完了。
      let metaStat = { filled: 0, left: 0 };
      try {
        const byPlay = games.slice().sort(function (a, b) {
          return (b.totalMinutes || 0) - (a.totalMinutes || 0);
        }).map(function (g) { return g.appid; });
        const wishIds = (wishStat && wishStat.ok) ? wishStat.appids : [];
        metaStat = await fillMeta(wishIds.concat(byPlay));
      } catch (e) { console.warn('补公共信息中断，本次同步继续', e); }

      // 核对成就（见 scanAchievements 注释）——「全成就 -> 已通关」靠它。
      // 失败不影响本次同步：时长/状态已经写进去了，成就下次再补。
      let achStat = { scanned: 0, perfect: 0, unknown: 0, left: 0 };
      try {
        achStat = await scanAchievements(profile.steam_id, touched);
      } catch (e) { console.warn('成就扫描中断，本次同步继续', e); }

      const tail = [];

      // ===== 愿望单这一段放最前 =====
      // 它是这次同步里用户最关心的新增内容（一导入就是几百张卡）。
      if (wishStat && wishStat.ok) {
        const wp = [];
        if (wishStat.added) wp.push('从愿望单导入 ' + wishStat.added + ' 款到待游玩');
        if (wishStat.removed) wp.push('已从愿望单移除 ' + wishStat.removed + ' 款，一并删掉了');
        if (wishStat.kept) wp.push('另有 ' + wishStat.kept + ' 款已不在愿望单但保留着（你动过它）');
        if (wp.length) tail.push(wp.join('；'));
      } else if (wishStat && wishStat.reason === 'unavailable') {
        // 「空」和「未公开」Steam 给的是同一份数据，别把话说死。
        // 详细的修法放进消息记录（能回看），提示条上只留一句。
        const steps = '读不到你的 Steam 愿望单。\n\n'
          + 'Steam 对「愿望单是空的」和「愿望单没公开」返回的是同一份数据，'
          + '所以下面两种可能都有：\n'
          + '  · 你的愿望单确实是空的（那就没事）\n'
          + '  · 「隐私设置 → 愿望单」不是「公开」\n\n'
          + (wishStat.howToFix || []).map(function (s, i) {
              return (i + 1) + '. ' + s;
            }).join('\n');
        if (global.GVLog) global.GVLog.push('warn', steps);
        tail.push('愿望单没读到（可能为空，也可能没公开，详见「消息」）');
      } else if (wishStat && wishStat.message) {
        tail.push(wishStat.message);
      }

      if (metaStat.filled) tail.push('补上 ' + metaStat.filled + ' 款的封面/发售年');
      if (metaStat.left) tail.push('还有 ' + metaStat.left + ' 款没补完，下次同步接着补');
      if (achStat.scanned) {
        tail.push('核对成就 ' + achStat.scanned + ' 款'
          + (achStat.perfect ? '（' + achStat.perfect + ' 款全成就）' : ''));
      }
      // ===== 没取到的原因，按**真实原因**措辞（2026-09-20 改）=====
      // 这里以前写死「（Steam 限流）」，把**所有**空值都贴上那个标签 ——
      // 而实测 4000+ 次请求一个 429 都没有，失败全在 TLS/读取层。
      // 那句话把判断带偏过两次（见 .workbuddy/memory/DESIGN.md）。
      // 现在原因标识由服务端给（server/steam_client.py 的 _ERROR_KINDS），
      // 中文措辞留在前端 —— 以后改文案不用动服务端。
      if (achStat.linkDown) {
        tail.push('这次连不上 Steam（网络不通），成就核对整轮跳过，下次同步自动继续');
      } else if (achStat.unknown) {
        const tally = achStat.reasons || {};
        const bits = Object.keys(tally)
          .sort(function (a, b) { return tally[b] - tally[a]; })
          .map(function (k) {
            return tally[k] + ' 款' + (ACH_REASON_TEXT[k] || ACH_REASON_TEXT.other);
          });
        tail.push(achStat.unknown + ' 款成就没取到'
          + (bits.length ? '（' + bits.join('、') + '）' : '')
          + '，下次自动补');
      }
      // 「还剩多少款从没核对过」必须说出来：这是唯一能回答
      // 「我还要点几次同步」的信息。不说的话，用户只会看到每次多加几款，
      // 以为功能坏了（真实反馈就是「每次同步最多只能检测 6 个吗」）。
      if (achStat.left) tail.push('还有 ' + achStat.left + ' 款从没核对过，下次同步继续');

      // 这条会很长（八十字上下），**不指定毫秒数** —— 交给 msglog 按字数给时间。
      // 原来的 6000 毫秒读不完这条，而它恰恰是唯一说明
      // 「哪儿没补完、下次会不会自动接着跑」的消息。
      toast('同步完成：共 ' + games.length + ' 款，新增 ' + stat.added
        + '，更新 ' + stat.updated + (tail.length ? '。' + tail.join('；') : ''), null, 'ok');
      await refreshApp();
    } catch (e) {
      console.warn(e);
      // 用提示条替代 alert：它会记进历史、顶栏亮未读角标 ——
      // 比一个「关掉就再也找不回来」的弹窗更符合「能回看」。
      toast('同步失败：' + ((e && e.message) || e), null, 'err');
    } finally {
      busy = false;
      if (btn) { btn.disabled = false; btn.textContent = old || '同步'; }
    }
  }

  // 每次同步最多补多少款游戏的商店信息，以及每次请求带多少个 appid。
  //
  // 为什么要限额：Steam 的商店接口**一款一次**（拼 appids=1,2,3 会被 400 拒绝，
  // 实测过），四百多款全量补要跑好几分钟。手机浏览器会先把后台标签页冻死 ——
  // 用户第一次同步就是这么半途而废的。
  // 改成「每轮补一批，进度存在公共缓存里，下次接着补」之后，
  // 单次同步时长就有上限了，而且中断也不会丢进度。
  //
  // 按服务端每款约 0.6~0.9 秒（0.3 秒出站间隔 + 请求本身）估，
  // 一批 15 款约 10~15 秒，一轮三批约半分钟 —— 这是能接受的上限。
  // 链路抽风时服务端有自己的软截止（STORE_DEADLINE），会在到点时
  // 把没问完的如实报回来，所以这里给大一点也不会把请求拖垮。
  const META_PER_RUN = 45;
  const META_BATCH = 15;

  /**
   * 补公共信息（名称 / 封面 / 发售年 / 类型 / 开发商），写进全站共享的公共缓存。
   *
   * 判定「还没补过」的依据是 game_meta.store_fetched，**不是「这一行在不在」**：
   * 合并游戏库的时候会顺手给每款游戏建一行 game_meta（带上名称），
   * 如果按行是否存在来判断，所有游戏一上来就都算「已缓存」，
   * 商店信息永远补不上（封面/发售年/类型会一直空着）。
   *
   * 返回 { filled, left }，left > 0 表示还有剩的，下次同步继续。
   */
  async function fillMeta(appids) {
    const ids = (appids || []).filter(function (a) { return a != null; });
    if (!ids.length) return { filled: 0, left: 0 };

    const have = await loadMeta(ids);
    const missing = ids.filter(function (a) {
      const m = have[a];
      return !m || !m.store_fetched;
    });
    if (!missing.length) return { filled: 0, left: 0 };

    const work = missing.slice(0, META_PER_RUN);
    let filled = 0, unanswered = 0;

    for (const part of chunk(work, META_BATCH)) {
      let d = null;
      try {
        d = await apiGet('/api/steam/store?appids=' + part.join(','));
      } catch (e) {
        // 整批都没回来（超时/被掐）—— 这批全部留到下次
        console.warn('补公共信息失败，这批留到下次', e);
        unanswered += part.length;
        continue;
      }
      const items = (d && d.items) || {};
      // unknown = 后端明说「这批没拿到答案」（网络/限流）。
      // 这些**不能标成已补**，否则那款游戏的封面永远补不回来。
      const unknown = new Set(((d && d.unknown) || []).map(String));

      // 拆成两组分别提交：两组的键集合不同，而 PostgREST 的批量 upsert
      // 要求同一批里每行的键完全一致，混在一起会被拒绝。
      const rich = [], bare = [];
      part.forEach(function (a) {
        const key = String(a);
        if (unknown.has(key)) { unanswered++; return; }
        const v = items[key];
        if (!v) {
          // Steam 明确回答「查不到」（下架 / 锁区）。记下「问过了」，
          // 但**不写任何字段** —— 免得用 null 把已有的名称/封面抹掉。
          bare.push({ appid: Number(a), store_fetched: true });
          return;
        }
        const yr = (String(v.release || '').match(/(19|20)\d{2}/) || [null])[0];
        rich.push({
          appid: Number(a),
          store_fetched: true,
          title: v.name || null,
          header: v.header || null,
          release_date: v.release || null,
          release_year: yr ? Number(yr) : null,
          genres: v.genres || [],
          developers: v.developers || []
        });
        filled++;
      });

      for (const group of [rich, bare]) {
        if (!group.length) continue;
        try {
          const { error } = await cloud.database.from('game_meta')
            .upsert(group, { onConflict: 'appid' });
          if (error) console.warn('写公共信息失败（不影响进度）', error);
        } catch (e) { console.warn('写公共信息失败（不影响进度）', e); }
      }
    }

    // left 要把「这轮没问完的」和「问了但没拿到答案的」都算上 ——
    // 后者虽然占了一个名额，进度其实没推进，下次还得来。
    return {
      filled: filled,
      left: Math.max(0, missing.length - work.length) + unanswered
    };
  }

  // ============================================================
  // 成就扫描
  // ============================================================
  // 作用：让「全成就 -> 已通关」这条自动规则在云端模式下也能成立。
  //
  // 为什么要单独扫：Steam 的 GetOwnedGames 只给时长，不给成就。
  // 成就得一款一款问（Steam 那边没有批量接口）。
  //
  // ===== 什么时候需要重扫一款游戏的成就 =====
  //
  // 全成就这个判定只依赖一个数：earned（已解锁数）。而 earned 只会因为
  // **启动游戏**而变化 —— 没跑过的游戏，成就数不可能自己涨。
  // 所以「全盘扫一遍」是纯浪费，只需要看三类：
  //
  //   ① 从来没查过（achievements == null）           -> 首次补数据，必须查
  //   ② 这次同步发现时长涨了（= 启动过）              -> 成就数可能变了，重查
  //   ③ 距上次全量核对超过 ACH_FULL_DAYS 天           -> 兜底，见下
  //
  // ② 的判定成本是**零**：时长就在本来就要拉的 GetOwnedGames 响应里，
  // 而且「比时长差」不像「最近 N 天」那样有时间窗口 —— 两次同步隔多久都不漏。
  //
  // ⚠️ ③ 存在的唯一理由：Steam 偶尔会给老游戏**追加新成就包**。这种情况下
  // 分母变了，但玩家根本没启动过它（时长不变），② 抓不到。
  // 所以留一个低频的全量兜底扫描，把它捞回来。
  //
  // ===== 每批款数（2026-09-20 重定）=====
  // 原来这里是 8，理由写得明明白白：「服务端每批 30 秒软截止，云端单款 2.6~3.7 秒，
  // 12 款一批必然超时被截断」。那个推理没错，但它是在**服务端逐个串行**的前提下成立的。
  // 现在服务端改成**并发**（在飞 12 个，见 steam_client.get_player_achievements_many），
  // 单批 60 款健康时约 10 秒，离 34 秒的 deadline 还差一半。
  // 实测依据：Steam 侧并发 32 跑完 200 余款只要 15.0 秒、零 429；我们是被自己那条
  // 0.8 秒**全局串行**节流拖住的。见 .workbuddy/memory/DESIGN.md「Steam 限流实测」。
  // ⚠️ 别再按"每款 2.5 秒 × 款数"去算这一批要多久 —— 并发之后那是错的口径。
  const ACH_BATCH = 60;      // 后端单次上限 ACH_MAX_IDS=120（app.py），留一倍余量
  const ACH_PER_RUN = 240;   // 每次同步最多扫多少款：一次同步就能覆盖整个库
  const ACH_FULL_DAYS = 30;  // 兜底全量重扫的间隔（天）

  // ===== 链路降级时的收窄批（2026-09-20 加）=====
  // 服务端每批有 34 秒截止，而**失败的请求要等满单款预算才肯放弃** ——
  // 所以「34 秒里塞得下几波」决定有多少款轮得到：
  //     健康时每波约 2 秒  -> 根本用不到这条
  //     抖动时每款等到 10 秒 -> 34 秒只塞得下 3 波，60 款的第 37 名以后必然拿不到
  // 线上实测的 null 分布正是这个形状（第 41–60 槽位连成一片、总耗时 33.3s ≈ 截止）。
  // 服务端会在这种情况下回 `link: "degraded"`，前端据此把批收窄，让两波就能覆盖——
  // 宁可多问几批，也别让尾巴整段轮不到。
  const ACH_BATCH_DEGRADED = 24;

  // 失败原因标识 -> 给用户看的话。标识是服务端给的稳定枚举
  // （见 server/steam_client.py 的 _ERROR_KINDS），**措辞放在前端**：
  // 以后改文案不用动服务端，两边也不会因为一句中文不一致而对不上。
  const ACH_REASON_TEXT = {
    timeout: '超时',
    tls: '加密连接失败',
    refused: '连接被中断',
    dns: '域名解析失败',
    ratelimit: '被限流',
    private: '这款档案不公开',
    other: '其他错误'
  };

  /** 距上次全量核对是否超过 ACH_FULL_DAYS 天（没记录过就算到期） */
  function achFullDue() {
    const t = profile && profile.ach_full_at ? Date.parse(profile.ach_full_at) : 0;
    if (!t || isNaN(t)) return true;
    return (Date.now() - t) > ACH_FULL_DAYS * 86400000;
  }

  async function markAchFull() {
    try {
      const v = new Date().toISOString();
      await cloud.database.from('profiles').upsert({ ach_full_at: v },
        { onConflict: 'owner_id' });
      if (profile) profile.ach_full_at = v;
    } catch (e) { console.warn('记录全量核对时间失败', e); }
  }

  /**
   * @param touched  这次同步里「时长涨了」的 appid 集合（见 syncNow）。
   *                 判定「哪些游戏被启动过」靠它 —— 这就是「只看最近玩过的」
   *                 那套思路的精确实现。
   */
  async function scanAchievements(steamid, touched) {
    touched = touched || new Set();
    let all;
    try { all = await DS.all(); }
    catch (e) { return { scanned: 0, perfect: 0, unknown: 0, left: 0 }; }

    const needFull = achFullDue();

    // 「玩过的」+「是游戏」才可能有全成就。
    // 工具 / 运行库（Wallpaper Engine、Godot、Proton、SteamVR…）被排除在外：
    // Steam 对它们往往回「没有 stats」或「档案不公开」，留着只会每轮白问一次。
    // ⚠️ 判「是不是工具」必须用 DS.isToolGame —— 它是 appid 名单 + 名称关键词
    //    两路判定，比隐藏标记准（隐藏里混着用户手动隐藏的真游戏）。
    const played = all.filter(function (g) {
      if (g.appid == null || (g.totalMinutes || 0) <= 0) return false;
      return !DS.isToolGame(g);
    });

    const byPlay = function (a, b) {
      return (b.totalMinutes || 0) - (a.totalMinutes || 0);
    };

    // 三组候选，**先后顺序就是本次修复本身，别调换**：
    //
    //  ① 这次启动过的（时长涨了）—— 成就数可能变了。**必须最先**：
    //     它是「增量」的原始承诺，用户刚通关一款，同步一次就该看到它进「已通关」，
    //     不能被一大批从没查过的游戏挤掉名额。
    //  ② 从没拿到过数据的         —— 排第二。这是唯一「扫了就真的前进」的一批。
    //  ③ 到期兜底重扫的           —— 只能排最后。Steam 偶尔给老游戏追加成就包
    //     （分母变了但玩家没启动过，①抓不到），但它的价值低于前两组。
    //
    // ⚠️ 踩过的坑（本次要修的就是它）：原来的 todo 是「三条件 or 在一起再按
    //    时长排序」，而 needFull 为真时第③条会把**全部已玩游戏**拉进候选，
    //    排序后取前 60 —— 于是每轮同步扫的都是**同一批时长最高的游戏**，
    //    排名靠后的那批从来没被扫过一次（线上库里 30 款有成就数据的
    //    游戏全部落在前 60 名内，一条例外都没有，就是这么来的）。
    //    而且 fullDone 要求 todo.length <= 60，230 > 60 永远不成立 →
    //    全量核对时间戳永远记不上 → needFull 永远为真 → 死循环。
    const noData = played.filter(function (g) {
      return g.achievements == null;
    }).sort(byPlay);
    const touchedHave = played.filter(function (g) {
      return g.achievements != null && touched.has(String(g.appid));
    }).sort(byPlay);
    const fallback = needFull ? played.filter(function (g) {
      return g.achievements != null && !touched.has(String(g.appid));
    }).sort(byPlay) : [];

    let work = touchedHave.slice(0, ACH_PER_RUN);
    if (work.length < ACH_PER_RUN) {
      work = work.concat(noData.slice(0, ACH_PER_RUN - work.length));
    }
    if (work.length < ACH_PER_RUN) {
      work = work.concat(fallback.slice(0, ACH_PER_RUN - work.length));
    }

    // 还要盯住「本轮把 noData 里的多少款真的问出了结果」—— 它决定还剩多少款
    // 从来没核对过，既用来判断一轮全量核对是否完成，也用来给用户报进度。
    const noDataKeys = new Set(noData.map(function (g) { return String(g.appid); }));
    let resolved = 0;

    if (!work.length) return { scanned: 0, perfect: 0, unknown: 0, left: noData.length };

    // ===== 开始扫描前，先花几秒探一次链路 =====
    // 为什么要探：链路整体断掉时，**每批**都要等满服务端 34 秒的截止才返回，
    // 一轮 7 批就是约 4 分钟白等（线上实测两条消息相隔 244 秒 = 7×34，就是这么来的）。
    // 这次探测最坏 6 秒，换来「立刻给出准确结论、并跳过整轮」。
    //
    // ⚠️ 只有**明确收到 {ok:false}** 才算链路断并跳过。
    //    如果这个请求本身抛异常（老版服务端没这个端点 / 服务端整体不可用），
    //    说明判断依据不成立 —— 那就照旧往下扫，让服务端的首波早退去下结论。
    //    把「探不到」当成「链路断」，会在灰度或回滚时误跳过整轮扫描。
    try {
      const p = await apiGet('/api/steam/ping');
      if (p && p.ok === false) {
        return { scanned: 0, perfect: 0, unknown: 0, left: noData.length,
                 linkDown: true, reasons: {} };
      }
    } catch (e) {
      console.warn('链路预检不可用（按「未断」处理，继续扫描）', e);
    }

    const total = work.length;
    let doneCount = 0, patch = [], unknown = 0, perfect = 0;
    let cursor = 0, batchSize = ACH_BATCH, linkDown = false;
    const reasonTally = {};

    // 用 while + 游标，而不是 for…of chunk：批大小要**按服务端回报的链路质量
    // 动态调整**，预先切好块的写法做不到这一点。
    while (cursor < work.length) {
      if (linkDown) {
        // 服务端已判定链路断，并把剩余款都如实报成了「不知道」。这里不再逐批去撞 ——
        // 每批仍要等满 34 秒，白等没有意义。如实算作本次没取到，下次同步再试。
        unknown += work.length - cursor;
        break;
      }
      const part = work.slice(cursor, cursor + batchSize);
      cursor += part.length;

      let d = null;
      try {
        d = await apiGet('/api/steam/achievements?steamid=' + steamid +
          '&appids=' + part.map(function (g) { return g.appid; }).join(','));
      } catch (e) {
        console.warn('成就查询失败，跳过这批', e);
      }
      const items = (d && d.items) || {};

      // ===== 读服务端回传的链路质量与失败原因（2026-09-20 加的字段）=====
      // 以前「没拿到」一律是 null，前端只能把所有失败都写成「Steam 限流」——
      // 而实测 4000+ 次请求一个 429 都没有，失败全在 TLS/读取层，那句话是错的。
      // 现在按真实原因措辞，并据此决定「还值不值得往下扫」「下一批开多大」。
      if (d && d.link === 'down') linkDown = true;
      if (d && d.link === 'degraded') batchSize = ACH_BATCH_DEGRADED;
      if (d && d.reasons) {
        Object.keys(d.reasons).forEach(function (k) {
          reasonTally[k] = (reasonTally[k] || 0) + (d.reasons[k] || 0);
        });
      }

      const metaRows = [];

      part.forEach(function (g) {
        const a = items[String(g.appid)];
        if (!a) {
          // 后端给了 null = 接口失败 / 被限流 / 档案不公开，也就是「不知道」。
          // 这种情况**一个字都不能写**：写进「没有成就」的话，这款游戏
          // 以后每轮同步都会被跳过，「全成就 -> 已通关」就永久失效了。
          // 留空即可，下次同步自然会重试。
          unknown++;
          return;
        }
        // 从「从没拿到过数据」变成「拿到了」—— 这才是真正往前推进了一步
        if (noDataKeys.has(String(g.appid))) resolved++;
        if (a.total > 0) {
          patch.push({ appid: g.appid, achievements: { earned: a.earned, total: a.total } });
          metaRows.push({ appid: g.appid, ach_total: a.total });
          if (a.earned >= a.total) perfect++;
        } else {
          // 明确查到了：这款游戏没有成就系统。记 0，下次直接跳过。
          patch.push({ appid: g.appid, achievements: { earned: 0, total: 0 } });
          metaRows.push({ appid: g.appid, ach_total: 0 });
        }
      });

      // 成就「总数」对所有人一样，属于公共信息，顺手写进共享缓存，
      // 让下一个用这个应用的人能少问几次 Steam。
      if (metaRows.length) {
        try {
          const { error } = await cloud.database.from('game_meta')
            .upsert(metaRows, { onConflict: 'appid' });
          if (error) console.warn('写成就总数失败（不影响进度）', error);
        } catch (e) { console.warn(e); }
      }

      doneCount += part.length;
      // 进度类：**覆盖**当前这条而不是排队（一批一条，排队会越积越多），
      // 并且不记历史 —— 记录里留最终结论就够了，中间进度没回看价值。
      toast('正在核对成就 ' + doneCount + '/' + total + ' …', 1500, 'info',
        { replace: true, silent: true });
    }

    // ===== 一轮「全量核对」什么时候算完成 =====
    // 语义：**所有玩过的游戏都已经拿到过成就数据**（哪怕是 0/0 = 这款没有成就）。
    // left = 还剩多少款从没拿到过数据；只要还剩一款，或本轮有没拿到的（unknown），
    // 就不能记账 —— 否则 30 天的兜底计时器会在还没扫完的时候就被重置。
    //
    // ⚠️ 原条件 `todo.length <= ACH_PER_RUN` 是坏的：needFull 为真时 todo 包含
    //    全部已玩游戏，永远大于 60 → 记账永不执行 → needFull 永远为真
    //    → 每轮都在同一批高时长游戏里打转。见 scanAchievements 顶部的注释。
    const left = Math.max(0, noData.length - resolved);
    const fullDone = needFull && left === 0 && unknown === 0;

    if (!patch.length) {
      if (fullDone) await markAchFull();
      return { scanned: 0, perfect: 0, unknown: unknown, left: left,
               reasons: reasonTally, linkDown: linkDown };
    }

    // 走原有的合并规则：全成就的会被自动归到「已通关」，
    // 已放弃 / 锁定的仍然不动（终态优先级在 mergeSteam 里）。
    // perfect 已在上面按「拿到的真实数据」统计过了，这里不再重复算。
    const n = patch.length;
    try {
      await DS.mergeSteam(patch);
    } catch (e) { console.warn('写入成就失败', e); }

    if (fullDone) await markAchFull();
    return { scanned: n, perfect: perfect, unknown: unknown, left: left,
             reasons: reasonTally, linkDown: linkDown };
  }

  // ============================================================
  // 顶栏接管：同步 / 账号菜单
  // ============================================================
  function takeoverUI() {
    // 同步按钮：换掉原有「选本地文件」的行为，改成直接拉 Steam
    const oldSync = q('btnSync');
    if (oldSync) {
      const fresh = oldSync.cloneNode(true);
      oldSync.parentNode.replaceChild(fresh, oldSync);
      fresh.addEventListener('click', function () { syncNow(fresh); });
    }
    // 更多按钮 -> 账号菜单
    const oldMenu = q('btnMenu');
    if (oldMenu) {
      const fresh = oldMenu.cloneNode(true);
      oldMenu.parentNode.replaceChild(fresh, oldMenu);
      // 本地/桌面模式下 ui.js 会把这个按钮隐藏（它原来装的「清空数据」已搬进
      // 「设置 → 危险操作」，按钮空了）；云端模式要把它拿回来当账号菜单 ——
      // cloneNode 会把 hidden 属性一起复制过来，所以这里显式冲掉。
      fresh.hidden = false;
      fresh.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleMenu();
      });
    }
    document.addEventListener('click', function () {
      const m = q('cvMenu');
      if (m) m.remove();
    });
  }

  function renderWho() {
    const sub = q('brandSub');
    if (!sub || !profile) return;
    const n = esc(profile.persona || '已连接 Steam');
    const t = profile.last_sync
      ? new Date(profile.last_sync).toLocaleString('zh-CN', { hour12: false })
      : '还没同步过';
    sub.innerHTML = 'Steam：' + n + ' · 上次同步 ' + esc(t);
  }

  function toggleMenu() {
    const exist = q('cvMenu');
    if (exist) { exist.remove(); return; }
    injectStyle();
    const el = document.createElement('div');
    el.id = 'cvMenu';
    el.className = 'cv-menu';
    el.innerHTML =
      '<div class="cv-id">' + esc(sessionUserEmail() || '已登录') + '</div>'
      + (profile && profile.steam_id
        ? '<div class="cv-id">Steam ID：' + esc(profile.steam_id) + '</div>' : '')
      + '<div class="cv-sep"></div>'
      + '<div class="cv-mi" data-a="sync">从 Steam 同步</div>'
      + (profile && profile.steam_id
        ? '<div class="cv-mi" data-a="rebind">换绑 Steam 账号</div>'
        : '<div class="cv-mi" data-a="bind">绑定 Steam 账号</div>')
      + '<div class="cv-mi" data-a="export">导出我的数据（备份）</div>'
      + '<div class="cv-mi" data-a="import">从备份导入</div>'
      + '<div class="cv-sep"></div>'
      + '<div class="cv-mi" data-a="signout">退出登录</div>';
    document.body.appendChild(el);
    el.addEventListener('click', function (e) {
      const a = e.target.closest('.cv-mi');
      if (!a) return;
      e.stopPropagation();
      el.remove();
      doMenu(a.dataset.a);
    });
  }

  function sessionUserEmail() {
    try {
      return (session && session.user && (session.user.email || session.user.id)) || '';
    } catch (e) { return ''; }
  }

  function doMenu(a) {
    if (a === 'sync') {
      const b = q('btnSync');
      syncNow(b);
    } else if (a === 'bind' || a === 'rebind') {
      location.href = '/auth/steam/start';
    } else if (a === 'export') {
      exportData();
    } else if (a === 'import') {
      importData();
    } else if (a === 'signout') {
      signOut();
    }
  }

  // ============================================================
  // 备份：导出 / 导入
  // ============================================================
  async function exportData() {
    try {
      const all = await DS.all();
      const blob = new Blob([JSON.stringify({
        app: '我的游戏生涯', version: 1,
        exportedAt: new Date().toISOString(),
        steamId: profile && profile.steam_id,
        games: all
      }, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'gamevault-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      toast('已导出 ' + all.length + ' 款', null, 'ok');
    } catch (e) {
      const m = '导出失败：' + (e.message || e);
      if (global.GVLog) global.GVLog.push('err', m);
      alert(m);
    }
  }

  function importData() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.addEventListener('change', async function () {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        const obj = JSON.parse(await f.text());
        const games = Array.isArray(obj) ? obj : (obj.games || []);
        if (!games.length) throw new Error('文件里没有游戏数据');
        if (!confirm('将导入 ' + games.length + ' 款游戏，覆盖同 appid 的现有记录。继续？')) return;
        const incoming = games.map(function (g) {
          return Object.assign({}, g, { suggestedStatus: g.status });
        });
        const stat = await DS.mergeSteam(incoming);
        toast('导入完成：新增 ' + stat.added + '，更新 ' + stat.updated, null, 'ok');
        await refreshApp();
      } catch (e) {
        const m = '导入失败：' + (e.message || e);
        if (global.GVLog) global.GVLog.push('err', m);
        alert(m);
      }
    });
    inp.click();
  }

  // ============================================================
  // 对外
  // ============================================================
  async function signOut() {
    try { await cloud.auth.signOut(); } catch (e) { /* ignore */ }
    session = null;
    profile = null;
    location.href = location.pathname;
  }

  async function ready() {
    if (!CFG.endpoint || !CFG.publishableKey) {
      console.warn('缺少云服务配置，退回本地模式');
      return true;
    }
    if (!global.WorkBuddyCloud) {
      alert('云端组件没加载出来。\n\n如果你是在本地双击打开这个文件的，'
        + '请改用服务器地址访问；本地版本请打开项目根目录的 index.html。');
      return false;
    }
    injectStyle();
    cloud = global.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: CFG.endpoint,
      publishableKey: CFG.publishableKey
    });

    await handleSteamCallback();

    try {
      const { data } = await cloud.auth.getSession();
      session = data || null;
    } catch (e) { session = null; }

    if (!session) { showGate('login'); return false; }
    return afterLogin();
  }

  global.Cloud = {
    enabled: true,
    ready: ready,
    signOut: signOut,
    syncNow: syncNow,
    profile: function () { return profile; }
  };
})(window);
