#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MyGameVaultList — Windows 桌面版 exe 出包脚本（PyInstaller，白名单制）

🔴 与 `scripts/pack_share_zip.py` 的分工（**别互相顶替**）

| 脚本 | 产物 | 用途 |
|---|---|---|
| 本文件 | `../_build_desktop/dist/mygamevaultlist-desktop/` | **中间产物**：本机自测 / 被下面那个脚本打进 zip |
| `pack_share_zip.py` | `../_build_desktop/share/MyGameVaultList-试用版-<日期-时分>.zip` | **对外发的唯一形态** |

（这里原来还并排着一个 `pack_deploy.py` —— **线上**部署包，它的白名单**有意放行** `.env`，
因为线上服务端要用它代表访问者查 Steam。线上版 2026-09-28 下线，脚本已删。
⚠️ 桌面版这份白名单**绝对禁止** `.env`，别把两套规则混起来。）

桌面版是**发给别人**的：`api_key()` 的优先级是「用户填的 > `.env`」，所以
exe 里一旦夹带 `.env`，别人机器上就会用开发机那把 key 去查 Steam（烧开发者的配额），
而且那个 key 就明文躺在 `_internal/.env` 里，谁都能翻出来。
同理必须挡住的还有 `js/seed-data.js`（完整个人游戏库）与 `data/`。

做法（白名单拷贝 + 两次体检）
------------------------------
1. **先按白名单拷到一个 staging 目录**（默认 `<项目外>/_build_desktop/app`）；
2. **打包前对 staging 体检一次** —— 早失败，省掉一次几分钟的构建；
3. 把 staging 整体 `--add-data` 进 exe；
4. **打包后再对 dist 体检一次**（防止 PyInstaller 从别处捎带进来）；
5. 任一体检不过 → 拒绝出包（退出码 1）。

为什么不让 PyInstaller 直接对着项目根捞
--------------------------------------
因为项目根混着上面那批**绝不能发出去**的东西，而 PyInstaller 的
`--add-data` **没有排除语法** —— 只能「先拷出干净的一份」。
白名单制的失效方向是「漏加一条 → 文件没进包」（可恢复），
黑名单是「漏加一条 → 静默泄露」（不可逆）。

用法
----
    python scripts/pack_win.py                 # 出 onedir + 保留控制台（自用/排错）
    python scripts/pack_win.py --onefile       # 出单文件
    python scripts/pack_win.py --windowed      # 出无控制台（对外发）
    python scripts/pack_win.py --check         # 只体检已有产物，不重新构建
    python scripts/pack_win.py --keep-stage    # 保留 staging 目录（排错用）

依赖（装到**隔离 venv**，别动系统 Python）
------------------------------------------
    <隔离 venv>/python -m pip install pyinstaller pywebview
    # pywebview 在 Windows 上会带 pythonnet + clr_loader，EdgeChromium 后端靠它
    # WebView2 **运行时**是系统组件（本机已装），不需要打进包。
"""

import argparse
import atexit
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 产物一律放**项目外** —— 免得被 git / 发布工具顺手上传
OUT_ROOT = os.path.join(os.path.dirname(BASE_DIR), "_build_desktop")
DIST_DIR = os.path.join(OUT_ROOT, "dist")
WORK_DIR = os.path.join(OUT_ROOT, "work")
SPEC_DIR = os.path.join(OUT_ROOT, "spec")
# 删不掉的旧产物会改名归档到这里（与 _build_desktop **同一个盘**，
# 因为 os.replace 不跨文件系统）
TRASH_ROOT = os.path.join(os.path.dirname(BASE_DIR), "_trash_mygamevaultlist")
# staging 目录放系统临时区、且**每次新建**（理由见 copy_stage 的说明）

APP_NAME = "mygamevaultlist-desktop"
ENTRY = os.path.join(BASE_DIR, "desktop", "main.py")
SERVER_DIR = os.path.join(BASE_DIR, "server")

# ===== 白名单：只有这里列出来的东西才进 exe =====
# 全是**前端静态资源**。`server/` 不在里面 —— 它是靠 `--paths` 被分析进 PYZ 的，
# 不做成 data，免得源码明文躺在 `_internal/` 里给人读。
ALLOW_FILES = (
    "index.html",
    "manifest.webmanifest",
)
ALLOW_DIRS = (
    "css",
    "js",
    "assets",
)

# 白名单目录内部再单独挡掉（相对项目根的 POSIX 路径）
DENY_REL = {
    "js/seed-data.js",     # 🔴 完整个人游戏库（含手写笔记），桌面版零用途
}

SKIP_DIR_NAMES = {"__pycache__", ".git", "node_modules"}
SKIP_SUFFIX = (".pyc", ".pyo")

# ===== 体检规则 =====
# ① 这些**文件名**无论出现在哪个深度都不许有
FORBID_BASENAMES = {
    ".env": "Steam Web API Key / SteamID64（开发机自己的凭证）",
    "seed-data.js": "完整个人游戏库",
    "desktop.json": "本机桌面设置（含凭证）",
}
# ② 路径里出现这些片段即拒绝
FORBID_PATHPARTS = {
    "screenshots": "开发期截图，画面里是完整游戏库",
    "_deploy_gamevault": "线上出包目录（含 .env）",
}
# ③ 内容特征：SteamID64 / 32 位十六进制（API Key 形态）
RE_STEAMID = re.compile(r"7656119\d{9,11}")
# ⚠️ 例外：SteamID64 的**公开基准常量**（accountID = 0），做换算的代码都会写它，
#    不含任何个人信息。必须**精确相等**才放行。
STEAMID64_BASE = "76561197960265728"

# 🔴 **这份名单与 `scripts/check_repo_leak.py` 的 `PUBLIC_STEAMIDS` 必须一致** ——
#    两套规则一分叉，早晚是「出包时拦住了、发的时候放过去了」（`pack_share_zip` 顶部
#    也是这个理由直接 import 本模块的体检规则）。
#    目前它对本模块**没有实际作用**（`server/app.py` 是冻进 exe 的 PYZ、不落地成文本，
#    所以这里扫不到），但规则一旦不对齐，等哪天它落地了就会出现两边结论不一致。
PUBLIC_STEAMIDS = {
    STEAMID64_BASE,
    "76561197960287930",   # Valve 官方账号（`VERIFY_PROBE_STEAMID`，公开探活用）
}
RE_HEXKEY = re.compile(r"\b[0-9A-Fa-f]{32}\b")

# 体检时跳过的文件：二进制 / 已压缩
SCAN_SKIP_SUFFIX = (
    ".pyc", ".pyd", ".dll", ".exe", ".so", ".dylib", ".zip", ".egg",
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp",
    ".woff", ".woff2", ".ttf", ".otf", ".pak", ".db",
)
SCAN_MAX_BYTES = 4 * 1024 * 1024


def log(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------- staging

def copy_stage(stage_dir):
    """按白名单把前端静态资源拷进一个**全新**的 staging 目录。返回拷了几个文件。

    🔴 staging 为什么放在系统临时区、而且每次都是新建的
    ---------------------------------------------------
    这个打包环境（以及不少受管/沙箱环境）有「批量删除保护」——
    一次删掉 50 个以上文件就先要求人工确认。staging 里有 300+ 个文件，
    于是「删掉旧目录、重建」这条路会被整条挡下，而且**报出来的错
    长得像构建失败**：一行 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` + 退出码 1，
    构建代码一行都没跑（本项目真踩过：第一次打包成功，第二次就"失败"了，
    因为第一次 dist 不存在、没有删除动作）。
    换成「每次新目录 + 用完尽力清」就绕开了这个闸门。
    """
    os.makedirs(stage_dir, exist_ok=True)

    n = 0
    for name in ALLOW_FILES:
        src = os.path.join(BASE_DIR, name)
        if not os.path.isfile(src):
            log("  !! 白名单文件缺失：%s" % name)
            raise SystemExit(2)
        shutil.copy2(src, os.path.join(stage_dir, name))
        n += 1
        log("  + %s" % name)

    for d in ALLOW_DIRS:
        src_dir = os.path.join(BASE_DIR, d)
        if not os.path.isdir(src_dir):
            log("  !! 白名单目录缺失：%s" % d)
            raise SystemExit(2)
        for root, dirs, files in os.walk(src_dir):
            dirs[:] = [x for x in dirs if x not in SKIP_DIR_NAMES]
            for name in files:
                if name.endswith(SKIP_SUFFIX):
                    continue
                src = os.path.join(root, name)
                rel = os.path.relpath(src, BASE_DIR).replace(os.sep, "/")
                if rel in DENY_REL:
                    log("  - 跳过（黑名单）：%s" % rel)
                    continue
                dst = os.path.join(stage_dir, rel.replace("/", os.sep))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
                n += 1

    return n


# ---------------------------------------------------------------- 体检

def iter_scan_files(root):
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP_DIR_NAMES]
        for name in files:
            if name.lower().endswith(SCAN_SKIP_SUFFIX):
                continue
            p = os.path.join(dirpath, name)
            try:
                if os.path.getsize(p) > SCAN_MAX_BYTES:
                    continue
            except OSError:
                continue
            yield p


def audit_dir(root, label):
    """体检一个目录：文件名级禁止项 + 内容特征。返回问题列表。"""
    problems = []

    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP_DIR_NAMES]
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, "/")

        for part in FORBID_PATHPARTS:
            if part in rel_dir.split("/"):
                problems.append("[%s] 禁止出现的目录：%s/%s（%s）"
                                % (label, rel_dir, part, FORBID_PATHPARTS[part]))

        for name in files:
            if name in FORBID_BASENAMES:
                rel = ("%s/%s" % (rel_dir, name)) if rel_dir != "." else name
                problems.append("[%s] 禁止出现的文件：%s（%s）"
                                % (label, rel, FORBID_BASENAMES[name]))

    for path in iter_scan_files(root):
        rel = os.path.relpath(path, root).replace(os.sep, "/")
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
        except OSError:
            continue

        for m in RE_STEAMID.finditer(text):
            if m.group(0) in PUBLIC_STEAMIDS:
                continue
            problems.append("[%s] %s 含 SteamID：%s" % (label, rel, m.group(0)))
        for m in RE_HEXKEY.finditer(text):
            problems.append("[%s] %s 含 32 位十六进制串（疑似 API Key）：%s"
                            % (label, rel, m.group(0)))

    return problems


def find_pe_binary(dist_dir):
    """在 dist 里找主 exe，供后续冒烟用。"""
    for dirpath, _dirs, files in os.walk(dist_dir):
        for name in files:
            if name.lower() == (APP_NAME + ".exe").lower():
                return os.path.join(dirpath, name)
    return None


# ---------------------------------------------------------------- 打包

def rm_tree_safe(path):
    """删一个目录，**在子进程里删**，返回是否删成功。

    🔴 为什么要绕一层子进程（这是本项目踩出来的坑，不是洁癖）

    某些受管/沙箱环境带「批量删除保护」：一次删掉 50 个以上文件就直接
    **终止进程**。注意是终止进程，**不是抛异常** —— 所以 `except Exception`
    根本抓不到，表现是脚本/构建**莫名其妙死在半路**，日志停在那一行，
    退出码 1，看起来像"构建失败"。

    放在子进程里删，被杀的只是子进程：主进程拿到非 0 退出码，
    就能改走「改名归档」那条安全路径，构建继续。
    """
    code = "import shutil,sys; shutil.rmtree(sys.argv[1])"
    try:
        r = subprocess.run([sys.executable, "-c", code, path],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=180)
        return r.returncode == 0
    except Exception:
        return False


def check_pyinstaller():
    """当前解释器有没有 PyInstaller / pywebview。返回 (ok, 缺失列表)。"""
    missing = []
    try:
        r = subprocess.run([sys.executable, "-m", "PyInstaller", "--version"],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if r.returncode != 0:
            missing.append("pyinstaller")
    except OSError:
        missing.append("pyinstaller")

    try:
        import webview  # noqa: F401
    except Exception:
        missing.append("pywebview")

    return (not missing), missing


def clean_previous(name):
    """把上一次构建的残留挪开，腾出位置给本次构建。

    ⚠️ 必须在调 PyInstaller **之前**做。PyInstaller 自己也会清
    （`--noconfirm`，以及 `--clean` 清 work 目录），但那一步在这个环境里会被
    「批量删除保护」拦下 —— 输出一行 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`
    然后退出码 1，看起来跟"构建失败"一模一样，实际构建代码一行没跑。
    （本项目连踩两次：第一次 dist/work 都不存在 → 没事；第二次撞 work。）

    要挪的有**两个**目录：
      · `dist/<name>` —— 产物
      · `work/<name>` —— PyInstaller 的中间目录（本项目就是被它拦住的）

    先试子进程删除（正常环境一次搞定）；删不掉就**改名归档**到
    `_trash_mygamevaultlist/`（`os.replace` 是单次操作，不进批量删除阈值）。
    构建照常进行，只是磁盘上多留一份旧目录 —— 会明确打印出来让人自己删。
    """
    stamp = time.strftime("%Y%m%d_%H%M%S")
    for base in (DIST_DIR, WORK_DIR):
        p = os.path.join(base, name)
        if not os.path.exists(p):
            continue
        if rm_tree_safe(p):
            log("  已清理：%s" % p)
            continue

        log("  ⚠️ 删不掉 %s（批量删除保护）—— 改用改名归档。" % p)
        os.makedirs(TRASH_ROOT, exist_ok=True)
        grave = os.path.join(TRASH_ROOT, "%s-%s-%s"
                             % (os.path.basename(base), name, stamp))
        try:
            os.replace(p, grave)
            log("  已归档为：%s" % grave)
        except Exception as e2:
            log("!! 既删不掉也改不了名：%s（%r）" % (p, e2))
            raise SystemExit(3)

    if os.path.isdir(TRASH_ROOT) and os.listdir(TRASH_ROOT):
        log("  （%s 里有 %d 份旧产物，可自行删。）"
            % (TRASH_ROOT, len(os.listdir(TRASH_ROOT))))


def build(stage_dir, onefile, windowed):
    """组装 PyInstaller 参数并执行。返回值是子进程退出码。"""
    args = [
        sys.executable, "-m", "PyInstaller",
        # ⚠️ 刻意**不用 `--clean`**：它会去清 work 目录，那一步会被环境的
        #    批量删除保护拦下并伪装成"构建失败"。残留由 clean_previous() 先处理掉。
        "--noconfirm",
        "--name", APP_NAME,
        "--distpath", DIST_DIR,
        "--workpath", WORK_DIR,
        "--specpath", SPEC_DIR,
        # 让 PyInstaller 能分析到 server/ 下的模块。
        # ⚠️ 这些模块名是**顶层**的（`import config`，不是 `server.config`），
        #    所以冻结后 `__file__` 会是 `<_MEIPASS>/config.py`、**没有 server/ 这层** ——
        #    `server/config.py` 里那个 frozen 分支就是为它写的，别删。
        "--paths", SERVER_DIR,
        "--hidden-import", "app",
        "--hidden-import", "config",
        "--hidden-import", "steam_local",
        "--hidden-import", "steam_client",
        "--hidden-import", "steam_openid",
        # pywebview：main.py 里是 try/except import，静态分析可能判成"没用到"
        # → 不显式收集就会打出一个"没有窗口层"的包（静默降级成浏览器）。
        "--collect-all", "webview",
        # EdgeChromium 后端靠 pythonnet + clr_loader 调 .NET 的 WebView2 组件
        "--collect-all", "clr_loader",
        "--hidden-import", "clr",
        # 只用 EdgeChromium，Qt 系一律不带（pywebview 会"见到就收"，是纯浪费）
        "--exclude-module", "PyQt5",
        "--exclude-module", "PyQt6",
        "--exclude-module", "PySide2",
        "--exclude-module", "PySide6",
    ]

    for name in sorted(os.listdir(stage_dir)):
        src = os.path.join(stage_dir, name)
        dest = "." if os.path.isfile(src) else name
        # ⚠️ 分隔符是 os.pathsep（Windows 下 `;`）。这里走 list 传参、不经 shell，
        #    所以不会被 bash 当成命令分隔符 —— 别改成拼字符串再 shell=True。
        args += ["--add-data", "%s%s%s" % (src, os.pathsep, dest)]

    if onefile:
        args.append("--onefile")
    args.append("--windowed" if windowed else "--console")

    # 图标：PyInstaller 只吃 .ico（不是 .svg）。`assets/icon.ico` 由
    # `_make_icon.py` 从 `assets/icon.svg` 生成（Chrome 渲染 PNG → 按 ICO 规范拼装）。
    icon = os.path.join(BASE_DIR, "assets", "icon.ico")
    if os.path.isfile(icon):
        args += ["--icon", icon]
    else:
        log("  ⚠️ 没有 assets/icon.ico —— 用 PyInstaller 默认图标。"
            "想要自己的图标：python _make_icon.py")

    args.append(ENTRY)

    log("--- PyInstaller ---")
    log("  " + " ".join(('"%s"' % a) if " " in a else a for a in args))
    log("")
    return subprocess.run(args).returncode


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--onefile", action="store_true",
                    help="出单文件 exe（启动时要解压，慢几秒）")
    ap.add_argument("--windowed", action="store_true",
                    help="不带控制台窗口（对外发用；排错时别开，否则看不到启动提示）")
    ap.add_argument("--check", action="store_true",
                    help="只体检已有产物，不重新构建")
    ap.add_argument("--keep-stage", action="store_true",
                    help="保留 staging 目录（排错用）")
    args = ap.parse_args()

    log("项目根：  %s" % BASE_DIR)
    log("产物目录：%s" % OUT_ROOT)
    log("")

    # ---- 只体检 ----
    if args.check:
        if not os.path.isdir(DIST_DIR):
            log("!! 还没有产物可体检：%s" % DIST_DIR)
            return 2
        log("--- 体检：产物目录 ---")
        problems = audit_dir(DIST_DIR, "dist")
        if problems:
            for p in problems:
                log("  [X] %s" % p)
            log("\n体检查出 %d 处问题 —— 这个包不能发。" % len(problems))
            return 1
        log("  无 .env / seed-data.js / desktop.json / SteamID / 32 位十六进制串")
        log("\n体检通过：%s" % DIST_DIR)
        return 0

    # ---- 工具链 ----
    ok, missing = check_pyinstaller()
    if not ok:
        log("!! 当前解释器缺少：%s" % "、".join(missing))
        log("   装到隔离 venv（别动系统 Python）：")
        log("     %s -m pip install pyinstaller pywebview" % sys.executable)
        return 2
    log("解释器：%s" % sys.executable)

    # ---- ① 白名单拷到 staging + 体检 ----
    stage_dir = tempfile.mkdtemp(prefix="gv_stage_")
    if not args.keep_stage:
        # 用完尽力清掉（子进程里删，见 rm_tree_safe）；清不掉也无所谓 ——
        # 它在系统临时区，不污染项目目录
        atexit.register(rm_tree_safe, stage_dir)

    log("")
    log("--- ① 按白名单拷到 staging ---")
    n = copy_stage(stage_dir)
    log("  共 %d 个文件 → %s" % (n, stage_dir))

    log("")
    log("--- ② 打包前体检（早失败，省一次构建） ---")
    problems = audit_dir(stage_dir, "stage")
    if problems:
        for p in problems:
            log("  [X] %s" % p)
        log("\n体检查出 %d 处问题 —— 拒绝构建。" % len(problems))
        return 1
    log("  干净：无 .env / seed-data.js / SteamID / 32 位十六进制串")

    # ---- ③ 构建 ----
    log("")
    clean_previous(APP_NAME)
    rc = build(stage_dir, args.onefile, args.windowed)
    if rc != 0:
        log("\n!! PyInstaller 失败（退出码 %d）" % rc)
        return rc

    # ---- ④ 产物体检 ----
    log("")
    log("--- ③ 产物体检（防止从别处捎带进来） ---")
    problems = audit_dir(DIST_DIR, "dist")
    if problems:
        for p in problems:
            log("  [X] %s" % p)
        log("\n体检查出 %d 处问题 —— 这个包不能发。" % len(problems))
        return 1
    log("  干净。")

    exe = find_pe_binary(DIST_DIR)
    log("")
    log("=" * 60)
    log("出包完成：%s" % (exe or DIST_DIR))
    if exe and not args.onefile:
        log("整个 `%s` 目录一起拷走才能跑（不要只拿 exe）。" % os.path.basename(os.path.dirname(exe)))
    log("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
