# 开发与维护

面向要改这个项目的人：命名与存储身份、目录结构、怎么验、怎么出包。
（[返回 README](../README.md)）

---

## 命名与存储身份（改名前必读）

> **名字的由来**：这个应用原来叫 `GameVault`，2026-09-29 改名为 **MyGameVaultList**。
> ⚠️ **只有"给人看的名字"改了** —— 下面这些**一个都没动**，动了就等于把用户已有的数据丢掉：
> 本地库名（IndexedDB 的 `gamevault`）、localStorage 键（`gamevault_games` / `gv_*`）、
> 数据目录（`%LOCALAPPDATA%\MyGameVault`）、以及仓库目录名（`gamevault/`）。

> **数据是你自己的。** 这个工具不自带任何人的游戏数据 —— 你克隆下来第一次打开是
> **空库**，跑一次同步脚本导入你自己的 Steam 库。所有记录都存在你自己的浏览器里。
>
> 仓库里**有意不包含**：任何人的游戏库、Steam API Key、SteamID。
> 上传前请跑一次 `python scripts/check_repo_leak.py`（见下面「提交前体检」）。

---

## 目录结构

```
gamevault/                  ⚠️ 目录名保持 gamevault（改名不含磁盘路径，见上面「命名与存储身份」）
├── index.html              主页面
├── manifest.webmanifest    PWA 清单
├── docs/                   分册文档（README 里放不下的长文）
├── css/
│   └── style.css           样式
├── js/
│   ├── platforms.js        平台注册表（有哪些平台、各自能给什么）—— 加平台只改这一个文件
│   ├── store.js            数据层（IndexedDB + 状态规则）
│   ├── ui.js               界面逻辑
│   ├── msglog.js           消息记录（底部提示 + 可回看）
│   ├── local-src.js        本机数据源（桌面版：把 /api/local/* 接进 store）
│   ├── epic-src.js         EPIC 数据源（桌面版：把 /api/local/epic 接进 store）
│   ├── coverfit.js         封面比例处理
│   ├── seed.js             首次打开的数据引导
│   └── seed-data.js        ⚠️ 你的个人数据，由 build-embed.py 生成，不进仓库
├── server/
│   ├── app.py              零依赖 HTTP 服务（静态 + /api/*）
│   ├── config.py           配置与环境变量
│   ├── steam_client.py     Steam Web API 客户端
│   ├── steam_local.py      读本机 Steam 文件（仅桌面模式注册）
│   ├── epic_local.py       读本机 EPIC 文件（仅桌面模式注册，**只读**）
│   └── steam_openid.py     Steam 登录
├── desktop/
│   └── main.py             桌面版启动器（本机服务 + 窗口）
├── scripts/
│   ├── sync.py             Steam 同步（本地 / 联网）
│   ├── build-embed.py      生成 js/seed-data.js
│   ├── pack_win.py         桌面版 exe 出包（白名单 + 体检）
│   ├── pack_share_zip.py   对外发的分享 zip（打包 + 校验）
│   └── check_repo_leak.py  提交前泄露体检
└── data/                   ⚠️ 个人数据，不进仓库
    ├── steam_sync.json     同步结果
    └── .cache/             缓存（成就、商店信息，避免重复联网）
```

---

## 开发与安全

### 提交前体检

```bash
python scripts/check_repo_leak.py            # 扫 git 跟踪的文件
python scripts/check_repo_leak.py --selftest # 只验规则本身有没有失效
python scripts/check_repo_leak.py --all      # 扫工作区全部文件（更严）
```

命中任意一条即拒绝上传：SteamID64（公开基准常量除外）、32 位十六进制串、
本机绝对路径。

### 改动后怎么验

```bash
bash _run.sh <页面> [预算]      # 单页；判定只看页面自己打的 RESULT: 行
bash _sweep.sh                 # 前端全量；跑完记得清仓库根的 _d_*.html
python _t_srv.py               # 服务端 + 静态断言
python _e2e_desktop_exe.py     # 打包出来的 exe 端到端（真 exe、真 DOM）
```

> ⚠️ **这些套件不在仓库里**（`_*` 前缀整个被 `.gitignore` 的白名单挡在外面）——
> 它们硬编码着维护者的本机路径与账号 ID，属于本地工具。随仓库发布出去的检查脚本
> **只有 `scripts/check_repo_leak.py` 一个**；外面克隆下来的仓库没有上面这套。

🔴 **凡是动了「已通关」区的拖放 / 边缘自动滚动，必须再用真手势探针在 exe 上跑一遍**：

```bash
python _probe_drag.py --exe "<dist 里的 mygamevaultlist-desktop.exe>"
python _probe_drag.py --exe "<dist 里的 mygamevaultlist-desktop.exe>" --no-intercept
python _probe_drag.py          # 本机 Chrome 那一版也要过
python _probe_autoscroll.py --exe "<dist 里的 mygamevaultlist-desktop.exe>"   # 边缘自动滚动
python _shot_autoscroll.py     # 出实图：拖动期边缘提示条到底看不看得见（clip + scale:2 放大）
```

理由：测试页里的 `new DragEvent(...)` 是**合成**事件 —— 它只证明"事件送到处理函数会
怎样"，跳过了整条原生链路（拖动到底有没有起来、拖动源是谁、`setData` 有没有被采纳）。
**「按在封面上下手，拖动源被封面图抢走」这个缺陷，合成事件永远是绿的**：
Chrome 里卡片的 `dragstart` 靠冒泡还能混过去，WebView2（桌面版）里则完全没有 drop
—— 用户看到的就是"拖动功能没实现"。

自动滚动更隐蔽一层：合成事件能把 `dragover` 送进处理函数，**但推不动
`requestAnimationFrame`，也造不出"指针贴着边缘停住不动"这个前提** —— 而那正是
"捏住卡片没法往下翻页"的现场。这一项只有真鼠标量得出来。真机基线（2026-09-30 实测，
指针贴边停 3 秒）：默认**完全不滚**（scrollTop 恒 0）、拖动会话里 rAF **照跑 60fps**、
`wheel` **收不到**。

🔴 而"数字都对"仍然不等于"用户看得见"：边缘提示条第一版写成 `.content` 的
`box-shadow: inset`，阴影落在容器**背景层**（子元素之前）→ **被卡片整个盖住**，
只剩卡片缝隙里露一点点，**代码怎么读都挑不出错**。所以 `_shot_autoscroll.py` 是必须的一件：
它真拖动 + CDP 截图，用 `clip` + `scale:2` 把底边放大，才看得出提示条到底在不在、
有没有被盖住。改成 `position: sticky` 伪元素后它才真的画在卡片之上。

⚠️ **`_probe_autoscroll.py` 要单独跑，别和别的重活串在一条命令里**：2026-10-08 把它接在
`_e2e_desktop_exe.py` + 两个拖放探针后面连着跑，读数漂了（行程 +1400、`wheel=16`）；
单独重跑立刻复现基线（`scrollHeight=8099`、+2640 / −2700、`wheel=0`、rAF +176）。
它量的是"真窗口的几何 + 计时"，刚被别的进程抢过 IO/CPU 时首屏同步还没落定。
（判定本身不受影响 —— PASS/FAIL 只看方向与量级，但**对外引用的数字必须来自单独跑的那次**。）

🔴 **凡是动了同步面板（进度显示 / 关面板 / 「正在同步中」那几个指示），必须再跑一遍**：

```bash
bash _run.sh _t_sync.html 180000                                             # 状态机（纯函数 + 三个指示的接线）
bash _run.sh _t_synclayout.html 300000                                       # 六档视口下的面板布局与超框
python _probe_syncbg.py --exe "<dist 里的 mygamevaultlist-desktop.exe>"     # 🔴 真鼠标：点同步→立刻关面板→看它有没有跑完
```
加 `--shot _shot_sync_live.png` 会顺带出**两张真窗口图**（点下去那一刻 / 中途重开那一刻），
只给人看、**不参与判定**；截图失败也不会把这一项变红。

理由：**「关掉这个界面同步就中断了」这条，代码怎么读都不该断**（`syncDesktop` 那一整条
`await` 链没有一处检查面板可见性），用户看到的"断了"其实是**重开面板时把进度复位了**
（原来 `openSyncModal()` 无条件清明细 + 状态行写回第一步）。所以这一项**必须用真鼠标
走一遍"点开→关掉→再点开"**：`_probe_syncbg.py` 真点按钮、真读 `syncProg`，
中途还注入一段延时把"关掉时它还在跑"这个窗口撑开（不注入的话这台机器上整条链几百毫秒
就跑完了，红绿全看运气）。
两个辅助判据：面板关着时**顶栏「同步」图标还在转**（唯一看得见的位置）；
收工后三个指示**全灭**（永远转 = 假信号，比没有更糟）。

⚠️ 这一项**只有 exe 能跑**：`state.desktop` 由 `/api/local/status` 探测决定，
双击版恒为 false，走的是"选文件"那条路，压根到不了 `syncDesktop`。
⚠️ 探针开头会先钉"被测 exe 里有没有本轮的新代码"（`GVSyncProg` / `#syncLive` / `.sync-spin`）——
拿一个**旧 exe** 跑，后面会变成 5 条看不懂的业务 FAIL，而真因只是包没重出（2026-10-10 绕过一圈）。

### 超框那类问题要在**多个视口**下量，别只量一档

`_t_synclayout.html` 现在跑两阶段：① 明细行的几何（2026-09-29 那条）；
② 六档视口（1180 / 900 / 860 / 700 / 520 / 380）下的**整面板审计**。第二阶段是 2026-10-10
为「全屏正常、窗口化超框」加的，它量出来的是**上一轮没覆盖到的第二种成因**：

```
遮罩 padding 20px → 可用宽 100vw-40px；窄屏媒体查询却给 .modal width: calc(100vw-24px)
→ 每档都宽出 16px（700px 视口实测：可用 660 / 弹窗 676），
  而 grid 的 place-items:center 在"元素比区域大"时退化成靠左 → 左 20px、右 4px。
```

三条做法值得抄：**边界取自真实内容盒**（`clientWidth` + computed padding，不写死 20px）；
**逐文本节点用 `Range.getClientRects()` 量墨迹盒**（元素盒子不越界、里面的文字一样可以
越界不换行，只查元素会漏）；**量之前先把入场动画停掉**（`pop` 的 `transform: scale(.96)`
在虚拟时间下冻在起点，`getBoundingClientRect` 拿到缩放后的盒子、`clientWidth` 是布局值
→ 混算出来的误差恰好是 `padding × 0.04 ≈ 0.7px`，六档**一致地**报"左越 0.7"，
第一版 15 条 FAIL 里有 12 条是这个假报）。

### 出包

```bash
python scripts/pack_win.py        # 桌面版 exe，产物在 ../_build_desktop/dist/
python scripts/pack_share_zip.py  # 对外发的分享 zip，产物在 ../_build_desktop/share/
```

**不要直接把项目根目录上传到任何静态托管** —— 根目录里混着个人数据与凭证。
出包脚本按白名单拷贝（默认拒绝），并保证 `.env` 与个人数据不在其中。

> 📌 这里原来还有个 `pack_deploy.py`（**线上**部署包）。线上版 2026-09-28 下线，脚本已删。
> ⚠️ 但那条规矩要记住：**它的白名单故意放行 `.env`**（线上服务端要用它代表访问者查 Steam），
> 与桌面版这套**刚好相反**。以后若再有人做部署，别把两套规则混起来用。

### 数据源

`js/store.js` 的 `patchDataStore()` 支持替换数据源，目前有两种：
浏览器本地（默认）、本机 Steam 文件（`js/local-src.js`，桌面模式）。

---

## 桌面版：打包成 exe（双击就能用，不用装 Python）

```bash
# 依赖装到隔离 venv 里（别动系统 Python）
python -m venv .venv-desktop
.venv-desktop/Scripts/python -m pip install pyinstaller pywebview

# 出包
.venv-desktop/Scripts/python scripts/pack_win.py
```

产物在 **项目外面**：`../_build_desktop/dist/mygamevaultlist-desktop/`（约 32 MB）。
里面的 `mygamevaultlist-desktop.exe` 双击就跑 —— ⚠️ **整个目录一起拷走**（`_internal/` 不能丢）。

打包脚本走**白名单**：只把前端静态资源 + `server/` 的代码装进去，
`server/` 是以编译进包的形式（源码不以明文落在 `_internal/` 里）。
包出来会自动做**两次泄露体检**（打包前一次、打包后一次），
查 `.env` / `js/seed-data.js` / `desktop.json` / SteamID / 32 位十六进制串，
任一不过就拒绝出包。

> ⚠️ **别拿「线上部署」那套白名单出 exe**：那份**故意包含 `.env`**（服务端要用它代表
> 访问者去查 Steam），而桌面版是发给别人用的，带上 `.env` 等于把 API Key 送出去 ——
> 两套白名单刚好相反。那个脚本（`pack_deploy.py`）随线上版 2026-09-28 下线已删，
> 但规矩留下：**桌面版的白名单永远禁 `.env`**。

### 出包时踩过的两个坑（已修，别再犯）

1. **pywebview 默认不会把数据存在磁盘上。** 它 `start()` 的默认参数是
   `private_mode=True` + 没有 `storage_path`，Windows 后端遇到这个组合会用**临时目录**
   （而且每次启动换一个）再开隐身模式 —— 结果是**你存的库、状态、感想，关掉窗口全没了**。
   所以 `desktop/main.py` 里固定传了 `private_mode=False, storage_path=%LOCALAPPDATA%\MyGameVault\webview`。
   🔴 这两个参数**缺一不可**。它和「端口必须固定 47615」是**两条独立的存储**：
   端口那条管的是浏览器存储的「源」，这条管的是 WebView2 自己那套。
2. **打包后 `__file__` 不再指向项目目录。** `server/config.py` 的 `BASE_DIR` 和
   `desktop/main.py` 的 `ROOT` 都靠它找静态文件，冻结后算法不一样 → 已加 `sys.frozen` 分支。
   不加的表现是：exe 打开**一片白**，或一启动就退。

### 验收

```bash
# 真 exe + 真窗口：写进存储 → 关窗 → 重开 → 把值读回来
python _e2e_desktop_exe.py

# 给打包出来的 exe 截一张真窗口图
python _shot_desktop_exe.py

# 换图标时（改完 assets/icon.svg 之后）
python _make_icon.py
```

### 图标

图标走 `assets/icon.ico` —— 它由 `_make_icon.py` 从 `assets/icon.svg` 生成
（用本机 Chrome 渲成 256/48/32/16 四张 PNG，再按 ICO 规范拼起来，不引额外依赖）。
`pack_win.py` 看到它就自动带上；换图标就改 `icon.svg` 再跑一次 `python _make_icon.py`。

### 怎么发给别人试用（出分享包）

```bash
python scripts/pack_share_zip.py --verify
```

产物 `../_build_desktop/share/MyGameVaultList_<版本号>.zip`（约 14.5 MB，微信/QQ 直接发得动）。
版本号在 `scripts/pack_win.py` 的 `APP_VERSION`（**唯一来源**，`pack_share_zip.py` 直接引用它），
现在出的是 `MyGameVaultList_0.0.2_alpha.zip`。
包里是 `使用说明.txt`（放 **zip 根**上，解压第一眼就看见）+ `mygamevaultlist-desktop/` 整个目录。

⚠️ 同名重出**不会覆盖**：旧包会被挪进 `../_trash_mygamevaultlist/share/` 存档。
所以「同版本号改了什么」能拿旧包现场比对；但要发新一版给用户时，**记得改版本号**，
否则收包人手上两个包都叫同一个名字，说不清哪个是最新的。

🔴 **不能只发 exe** —— 反向对照实测：单独把 exe 拷出来会报
`Failed to load Python DLL '...\_internal\python313.dll'` 然后退出（退出码 -1）。
（那行系统错误文本本身还是乱码的，所以说明书里写的是「看到 `Failed to load Python DLL`
就是这个原因」，而不是照抄系统原文。）

那份说明书替你讲了收包人最容易卡住的四件事，每条都是实测出来的：
SmartScreen 要点「更多信息 → 仍要运行」；exe 不能单独拖出来；**首屏是空的要点「同步」**
（数据来自他本机 Steam）；数据存在他本机 `%LOCALAPPDATA%\MyGameVault`、出问题先别关那个黑窗。

脚本干三件事：压之前**复用 `pack_win` 的体检规则**再查一遍（规则不重抄一份，
免得两套分叉成「出包拦住了、发的时候放过去了」）→ 压完**从 zip 里读回来**验结构 / 夹带 /
说明书文件名编码 → 打印 SHA-256（对方说打不开时先核这个值）。
`--verify` 会顺带解出一份并打印 exe 路径，可以接着跑
`python _e2e_desktop_exe.py --exe <那个 exe>` 证明压出来的能跑。

⚠️ 中文路径验过：解到 `…\MyGameVaultList 试用版（分享包）\`、数据目录也用中文名，
`_e2e_desktop_exe.py --home <中文目录>` 依然 **31 PASS / 0 FAIL**
（e2e 的 `--home` 参数就是为复现「中文用户名」这种真实环境加的）。
⚠️ 这个数字**每加一个功能就会涨**（每轮都给 e2e 补一条对应的检查）——
判据只看 `FAIL=0`，别拿旧数字对账。

### 还没做的

- **无控制台版**（`--windowed`）还没出，而且**自用测试阶段不该出**：找不到 Steam、
  端口被占用（退出码 3）这些提示都走控制台输出，去掉控制台就什么都看不见了 ——
  而那些提示正是排错要看的东西。要对外发得先给这些错误补弹窗兜底。
- 首次启动的设置向导。
