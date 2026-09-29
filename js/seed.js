/*
 * MyGameVaultList — 内置初始数据引导
 * 首次打开时，如果 IndexedDB 是空的，自动把 data/steam_sync.json 灌进去。
 * 之后所有改动都存本地，不会被这个文件覆盖。
 *
 * 注意：file:// 协议下 fetch 本地 json 会被浏览器拦截，
 * 所以这里额外支持 data.js 内联数据（由 build-embed 脚本生成）。
 */

(function () {
  'use strict';

  /*
   * 按需加载 js/seed-data.js —— 它由 scripts/build-embed.py 从**你自己的**游戏库
   * 内联生成，属于个人数据，所以**不随仓库分发**。
   *
   * 因此这里不能用 index.html 里的静态 <script>：新克隆的仓库没有那个文件，
   * 静态引入会让每次打开都在控制台报一个 404，看起来像坏了。
   * 改成动态加载并接住 onerror：有就用，没有就安静跳过 —— 空库启动是**预期行为**，
   * 使用者自己跑一次 scripts/sync.py 就有了（见 README「快速开始」）。
   *
   * 返回值必须 await：seedIfEmpty 由 ui.js 的 boot() await 调用，
   * 不等待的话可能在上面的数据落地前就去读 __SEED_GAMES__。
   */
  function loadSeedData() {
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'js/seed-data.js';
      s.onload = function () { resolve(true); };
      s.onerror = function () { resolve(false); };   // 仓库分发版本：文件不存在，属预期
      document.head.appendChild(s);
    });
  }

  async function seedIfEmpty() {
    const DS = window.DataStore;
    if (!DS) return;

    const existing = await DS.all();
    if (existing.length) return;   // 已有数据，什么都不做

    let list = null;

    // 方式 1：内联数据（file:// 下也能用）
    if (!window.__SEED_GAMES__) await loadSeedData();
    if (window.__SEED_GAMES__ && Array.isArray(window.__SEED_GAMES__)) {
      list = window.__SEED_GAMES__;
    }
    // 方式 2：fetch（需要 http 服务）
    if (!list) {
      try {
        const res = await fetch('data/steam_sync.json', { cache: 'no-store' });
        if (res.ok) list = await res.json();
      } catch (e) { /* file:// 下会失败，忽略 */ }
    }

    if (!list || !list.length) return;

    // 🔴 必须**先**做旧分类名迁移，再算 suggestedStatus。
    // 此刻库里是空的，mergeSteam 内部那次迁移看不到任何"老数据"；
    // 而下面算出的 suggestedStatus 会被 mergeSteam 直接当新建状态用，
    // 顺序反了的话，种子数据里靠「完结撒花」进来的款会静默落成「我的游戏单」。
    DS.adoptLegacyCollection(list);

    // mergeSteam 期望每个条目带 suggestedStatus 字段（它据此决定自动归类）。
    // 注意：不能在 makeGame 之后再传 suggestedStatus: undefined ——
    // mergeSteam 里用的是 `src.suggestedStatus || LIBRARY`，undefined 会全部退化成「我的游戏」。
    const prepared = list.map(src => {
      const g = DS.makeGame(src);
      return Object.assign({}, g, { suggestedStatus: DS.suggestStatus(g) });
    });

    await DS.mergeSteam(prepared);
    window.__SEEDED__ = prepared.length;
  }

  window.__seedIfEmpty = seedIfEmpty;
})();
