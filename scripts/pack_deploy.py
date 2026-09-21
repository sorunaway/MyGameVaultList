#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GameVault — 上线出包脚本（白名单制）

把「线上真正需要的东西」拷进一个干净的出包目录，发布工具上传**这个目录**，
而不是项目根目录。

为什么必须有这一步
------------------
线上服务跑在别人机房里，放在那儿的每个字节都出了你的手。而项目根目录里
混着一批**绝不能上线**的东西：

  ① 个人数据 —— `data/steam_sync.json`（整个游戏库）、`js/seed-data.js`
     （库 + 手写笔记）、`screenshots/`（界面截图，带全屏游戏名）、
     以及各种 `_*.json` 探测缓存；
  ② 凭证 —— `scripts/sync.py` 里曾硬编码过一把 Steam Web API Key。

`.gitignore` 拦不住这些：**发布工具是整目录压缩上传，不读 .gitignore。**

规则：只按白名单拷（默认拒绝）
------------------------------
不按黑名单排除 —— 以后往项目里加新文件时，忘了加白名单只是「没上线」，
不会变成「泄露」。这个方向的失效是安全的。

`.env` 是有意放行的
-------------------
服务端要拿它里面的 `STEAM_API_KEY` 代表访问者去查 Steam，没有它线上功能
直接停摆。它是**运行必需的凭证**，不是个人数据；而且它不在静态白名单
（`config.STATIC_FILES` / `STATIC_DIRS`）里，公网下载不到。

用法
----
    python scripts/pack_deploy.py                # 出包到 ../_deploy_gamevault
    python scripts/pack_deploy.py --out DIR      # 指定出包目录
    python scripts/pack_deploy.py --check        # 只体检已有出包目录，不重新拷
"""

import argparse
import os
import re
import shutil
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(os.path.dirname(BASE_DIR), "_deploy_gamevault")

# ===== 白名单：只有这里列出来的东西才会上线 =====
ALLOW_FILES = (
    "index.html",
    "manifest.webmanifest",
    ".env",              # 见文件头说明：运行必需的凭证，非个人数据
)
ALLOW_DIRS = (
    "css",
    "js",
    "assets",
    "vendor",
    "server",
)

# 白名单目录内部再单独挡掉的文件（相对项目根的 POSIX 路径）
DENY_REL = {
    "js/seed-data.js",    # 完整个人游戏库（本地双击版用），线上零用途
    "vendor/README.md",   # 维护者说明，对外无价值
}

SKIP_DIR_NAMES = {"__pycache__", ".git", "node_modules"}
SKIP_SUFFIX = (".pyc", ".pyo")

# ===== 出包后的体检规则 =====
# 个人数据特征：SteamID64（7656119 开头）
RE_STEAMID = re.compile(r"7656119\d{9,11}")
# ⚠️ 例外：SteamID64 的**公开基准常量**（accountID = 0 时的取值）。
# 任何做 SteamID 换算的代码都会写它（例：server/steam_local.py 的 `STEAMID64_BASE`），
# 它不含任何个人信息。必须**精确相等**才放行 —— 真实账号 ID 同样是 17 位，
# 只会以「另一个不同的数」出现，不会被这条误放。
STEAMID64_BASE = "76561197960265728"
# 凭证特征：32 位十六进制（Steam Web API Key 的形态）
RE_HEXKEY = re.compile(r"\b[0-9A-Fa-f]{32}\b")
# 体检扫描跳过的文件：第三方库与压缩产物，里面本来就全是哈希/十六进制
SCAN_SKIP_PREFIX = ("vendor/",)
SCAN_SKIP_SUFFIX = (".png", ".jpg", ".jpeg", ".ico", ".woff", ".woff2", ".svg")


def log(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def rel_posix(path):
    return os.path.relpath(path, BASE_DIR).replace(os.sep, "/")


def iter_payload_files(out_dir):
    for root, dirs, files in os.walk(out_dir):
        dirs[:] = [d for d in dirs if d not in SKIP_DIR_NAMES]
        for name in files:
            yield os.path.join(root, name)


def copy_tree(out_dir):
    """按白名单把运行时文件拷进出包目录。返回拷贝的文件数。"""
    n = 0

    for name in ALLOW_FILES:
        src = os.path.join(BASE_DIR, name)
        if not os.path.isfile(src):
            log("  !! 白名单文件缺失：%s" % name)
            raise SystemExit(2)
        shutil.copy2(src, os.path.join(out_dir, name))
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
                rel = rel_posix(src)
                if rel in DENY_REL:
                    log("  - 跳过（黑名单）：%s" % rel)
                    continue
                dst = os.path.join(out_dir, rel.replace("/", os.sep))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
                n += 1

    return n


def audit(out_dir):
    """体检出包目录：不允许出现个人数据或硬编码凭证。返回问题列表。"""
    problems = []

    for path in iter_payload_files(out_dir):
        rel = os.path.relpath(path, out_dir).replace(os.sep, "/")

        if rel == ".env":
            continue                      # 有意放行，见文件头
        if rel.startswith(SCAN_SKIP_PREFIX):
            continue
        if rel.lower().endswith(SCAN_SKIP_SUFFIX):
            continue
        if os.path.getsize(path) > 2 * 1024 * 1024:
            continue

        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
        except OSError:
            continue

        for m in RE_STEAMID.finditer(text):
            if m.group(0) == STEAMID64_BASE:
                continue                      # 公开基准常量，不是个人数据
            problems.append("%s 含 SteamID：%s" % (rel, m.group(0)))
        for m in RE_HEXKEY.finditer(text):
            problems.append("%s 含 32 位十六进制串（疑似 API Key）：%s"
                            % (rel, m.group(0)))

    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--check", action="store_true",
                    help="只体检已有出包目录，不重新拷贝")
    args = ap.parse_args()

    out_dir = os.path.abspath(args.out)

    if args.check and os.path.isdir(out_dir):
        log("出包目录：%s" % out_dir)
    else:
        log("项目根：  %s" % BASE_DIR)
        log("出包目录：%s" % out_dir)
        if os.path.isdir(out_dir):
            shutil.rmtree(out_dir)
        os.makedirs(out_dir, exist_ok=True)
        log("--- 按白名单拷贝 ---")
        n = copy_tree(out_dir)
        log("共 %d 个文件" % n)

    log("")
    log("--- 体检：不该出现的个人数据 / 硬编码凭证 ---")
    problems = audit(out_dir)
    if problems:
        for p in problems:
            log("  [X] %s" % p)
        log("")
        log("体检查出 %d 处问题 —— 拒绝出包。" % len(problems))
        return 1

    log("  无 SteamID、无 32 位十六进制串（vendor/ 与图片除外）")
    log("")
    log("体检通过，可以上传：%s" % out_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
