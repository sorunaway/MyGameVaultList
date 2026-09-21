/* 封面自适应：画框比例是固定的，素材比例却五花八门。
 *
 * 卡片与详情页的画框都写死 `aspect-ratio: 460 / 215`（≈2.14，正是 Steam
 * `header.jpg` 的原始比例）。而素材实测有四种比例：
 *
 *   header.jpg            460×215   2.14   ← 与画框完全一致
 *   library_hero.jpg     1920×620   3.10
 *   library_600x900.jpg   300×450   0.67   ← 竖图（注意文件名写 600x900，实际是这个）
 *   logo.png              640×160   4.00
 *
 * 🔴 用 `object-fit: cover` 硬填的话，比例差多少就裁多少：竖图（0.67）进 2.14 的
 *    横框，可见面积只剩 `0.67 / 2.14 ≈ 31%` —— 角色的头当场被裁掉（2026-09-21 实际发生）。
 *
 * 所以 CSS 一律用 `contain`（**永不裁内容**）；比例对不上的再挂一个 `pad` 类，
 * 由 CSS 用同一张图铺一层模糊底把空档填上（见 `style.css` 的 `.card-media.pad::before`）。
 *
 * ⚠️ 判据用图片**自己的** `naturalWidth / naturalHeight`（运行时量），不是文件名 ——
 *    同一台机器上 `library_600x900.jpg` 的真实尺寸是 300×450，文件名里的数字不可信。
 */
(function () {
  'use strict';

  var FRAME = 460 / 215;     // 画框比例，与 CSS 里的 aspect-ratio 必须一致
  var TOLERANCE = 0.08;      // 比例偏差超过 8% 才需要垫底（懒得为 1~2px 空档铺图）

  /* 读不到尺寸（还没解码 / 加载失败）时**什么都不做** —— 不猜、不改类。 */
  function apply(img) {
    if (!img || !img.parentNode) return;
    var host = img.parentNode;
    var w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return;

    var ratio = w / h;
    var off = Math.abs(ratio - FRAME) / FRAME;
    if (off > TOLERANCE) {
      // 模糊底要同一张图：写在元素上，CSS 用 var(--cov) 取。
      // 用 currentSrc（真正加载的那张），拿不到再退回 src。
      var url = img.currentSrc || img.src;
      if (url) host.style.setProperty('--cov', 'url("' + url + '")');
      host.classList.add('pad');
    } else {
      host.classList.remove('pad');
      host.style.removeProperty('--cov');
    }
  }

  window.GVCoverFit = {
    FRAME: FRAME,
    TOLERANCE: TOLERANCE,
    apply: apply
  };
})();
