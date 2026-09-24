#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GameVault — 仓库泄露体检（上传到公开仓库前跑一次）

为什么单独有一个（和 scripts/pack_deploy.py 的体检不是一回事）
------------------------------------------------------------
`pack_deploy.py` 只体检**上线出包目录**，而那个目录是静态白名单
（`css/ js/ assets/ vendor/ server/` + 三个根文件）—— 也就是说
**`scripts/` 从来没有被它扫过**。仓库要公开的是另一批文件（含 `scripts/`
和文档），扫描范围不同，规则也不该共用一份。

判据（命中任意一条即失败）
--------------------------
1. SteamID64（`7656119` 开头的 17 位），**除了公开基准常量**；
   基准常量是「accountID = 0」时的取值，任何做 SteamID 换算的代码都会写它，
   不含任何个人信息。必须**精确相等**才放行 —— 真实账号 ID 同样是 17 位，
   只会以「另一个不同的数」出现，不会被误放。
2. 32 位十六进制串（Steam Web API Key 的形态）。
3. 本机绝对路径（`E:\\WorkBuddy\\...` 之类）写进了会被公开的脚本/文档 ——
   不是隐私，但会让别人的克隆直接跑不起来。

用法
----
    python scripts/check_repo_leak.py              # 扫 git 已跟踪的文件
    python scripts/check_repo_leak.py --all        # 扫工作区全部文件（更严）
    python scripts/check_repo_leak.py --file X     # 只扫单个文件（调试用）
"""

import argparse
import os
import re
import subprocess
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# SteamID64 的公开基准常量：accountID = 0 时的取值，不含个人信息
STEAMID64_BASE = "76561197960265728"

# 另外几个**公开且可查证**的 SteamID64 —— 不是谁的私人数据，所以放行。
# ⚠️ 加这里必须满足两条：① 是**公开知名账号**（不是身边任何人的）；② 在注释里写清是谁。
#    2026-09-24 加 `76561197960287930`：那是 **Valve 自家账号**，
#    用在 `server/app.py:VERIFY_PROBE_STEAMID` —— 「验证并保存 API Key」时拿它探一次
#    `/GetOwnedGames`，只看接口认不认这把 key，不看返回内容（所以填哪个 id 结论都一样）。
#    不改成假 ID 是因为**没有证据**证明假 id 的响应与真 id 同构（拒绝/无效账号可能
#    走不同分支），而这个值又不含任何私人信息 —— 放行比"顺手换个值"风险小。
# ⚠️ 放行是**名单制**，不是放宽正则：正则照旧拦截其他所有 7656119 开头的 17 位。
# 🔴 **这份名单与 `scripts/pack_win.py` 的 `PUBLIC_STEAMIDS` 必须一致**（同一个值、
#    同一条正则写在两个脚本里；不对齐就会两边结论不同）。
PUBLIC_STEAMIDS = {
    STEAMID64_BASE,
    "76561197960287930",   # Valve 官方账号（公开基准用）
}

RE_STEAMID = re.compile(r"7656119\d{9,11}")
RE_HEXKEY = re.compile(r"\b[0-9A-Fa-f]{32}\b")
# 本机绝对路径：盘符 + Users/WorkBuddy 之类。
# ⚠️ 写法要能吃下单反斜杠（`E:\WorkBuddy`）和正斜杠（`E:/WorkBuddy`）两种；
#    2026-09-21 修：上一版正则写成 `\\\\`（匹配**双**反斜杠），
#    而真实源码里是单反斜杠 → 这条规则**永远不触发**，体检假通过。
#    靠 --selftest 里的向量把它钉住了。
RE_LOCALPATH = re.compile(r"[A-Za-z]:[\\/]+(?:Users|WorkBuddy)\b")

# 跳过的文件：二进制、第三方库、以及体检脚本自身（规则里就写着这些模式）
SKIP_SUFFIX = (".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2",
               ".zip", ".exe", ".pyc")
SKIP_PREFIX = ("vendor/",)
# 🔴 体检**不扫自己**（下面这两个）。代价是一个真实的盲区：
#    这个文件里写进去的东西，这套检查**永远看不见**。
#    2026-09-22 就因为这条踩了一次 —— `selftest()` 的样例里把 `.env` 那把真 Key
#    原样抄了一遍，于是「防泄露的脚本」自己成了仓库里唯一的泄露点，
#    还随着初始提交进了历史。样例只要形状对就够了，**永远不要填真值**。
#    （改完这个文件请务必 `--selftest` 复跑，规则的真假只有它验得出来。）
SKIP_EXACT = {"scripts/check_repo_leak.py", ".gitignore"}


def tracked_files():
    out = subprocess.run(["git", "ls-files"], cwd=BASE_DIR,
                         capture_output=True, text=True, check=True).stdout
    return [p for p in out.splitlines() if p.strip()]


def walk_files():
    for root, dirs, files in os.walk(BASE_DIR):
        dirs[:] = [d for d in dirs
                   if d not in {".git", "__pycache__", "node_modules", ".vtmp", ".tmpdl"}]
        for name in files:
            yield os.path.relpath(os.path.join(root, name), BASE_DIR).replace(os.sep, "/")


def audit(paths):
    problems = []
    scanned = 0

    for rel in paths:
        if rel.startswith(SKIP_PREFIX) or rel in SKIP_EXACT:
            continue
        if rel.lower().endswith(SKIP_SUFFIX):
            continue
        full = os.path.join(BASE_DIR, rel.replace("/", os.sep))
        if not os.path.isfile(full) or os.path.getsize(full) > 2 * 1024 * 1024:
            continue
        try:
            with open(full, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
        except OSError:
            continue
        scanned += 1

        for m in RE_STEAMID.finditer(text):
            if m.group(0) in PUBLIC_STEAMIDS:
                continue
            problems.append("%s  含 SteamID64：%s" % (rel, m.group(0)))
        for m in RE_HEXKEY.finditer(text):
            problems.append("%s  含 32 位十六进制串（疑似 API Key）：%s" % (rel, m.group(0)))
        if RE_LOCALPATH.search(text):
            problems.append("%s  含本机绝对路径（别人克隆后跑不起来）" % rel)

    return scanned, problems


def selftest():
    """
    自检：每条规则都必须能命中"该命中的"、放行"该放行的"。

    为什么必须有：这套体检的价值**完全依赖正则真的会触发**。
    2026-09-21 实测踩中 —— 路径规则写成匹配双反斜杠，而源码里是单反斜杠，
    于是它对任何文件都返回"干净"，体检**假通过**，看起来一切正常。
    一条恒不触发的检查比没有检查更坏：它让人以为已经查过了。
    """
    # (样本文本, 该不该被判为问题)
    vectors = [
        ("SteamID64 公开基准常量 → 放行", "x = " + STEAMID64_BASE, False),
        # ⚠️ 这两条要成对看：放行是**名单制**，不是把正则放宽。
        #    只加"放行"那条的话，一个把正则改成 `7656119\d*` 的错改也能骗过自检。
        ("Valve 官方账号（公开探活用）→ 放行", 'PROBE = "76561197960287930"', False),
        ("名单外的 17 位 ID → 仍拦截（证明放行是名单，不是放宽）",
         'sid = "76561198099999999"', True),
        ("真实 SteamID64 → 拦截", "sid = 76561198012345678", True),
        ("本机路径反斜杠 → 拦截", r'BASE = r"E:\WorkBuddy\2026-09-16\p"', True),
        ("本机路径正斜杠 → 拦截", 'p = "E:/WorkBuddy/p"', True),
        ("C 盘用户目录 → 拦截", r"C:\Users\someone\bin\x.exe", True),
        ("普通相对路径 → 放行", 'p = "scripts/sync.py"', False),
        # 🔴 这里**绝对不能用真 Key 当样例** —— 2026-09-22 审计发现，
        #    最初的版本把 `.env` 里那把真 Key 原样抄进了这条样例，
        #    于是"用来防泄露的脚本"自己成了泄露点（在初始提交里就进了仓库历史）。
        #    样例只要**形状对**（32 位十六进制）就能验到规则，不必是真的。
        ("32 位十六进制 → 拦截", "KEY = 'DEADBEEFCAFEBABE0123456789ABCDEF'", True),
        ("短十六进制 → 放行", "h = 'a1b2c3d4'", False),
    ]

    fails = 0
    for name, text, should_flag in vectors:
        # ⚠️ 必须用**同一个** PUBLIC_STEAMIDS 判定，不能在这里另写一份
        #    （两套规则一分叉，自检就会开始说谎）—— 用的是主扫描那份常量。
        hit = bool(
            any(m.group(0) not in PUBLIC_STEAMIDS for m in RE_STEAMID.finditer(text))
            or RE_HEXKEY.search(text)
            or RE_LOCALPATH.search(text)
        )
        ok = (hit == should_flag)
        if not ok:
            fails += 1
        print("  %s %s" % ("PASS" if ok else "FAIL", name))

    print("")
    print("自检 RESULT: %s (FAILS=%d)" % ("OK" if fails == 0 else "BROKEN", fails))
    return 1 if fails else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="扫工作区全部文件，不只 git 跟踪的")
    ap.add_argument("--file", default=None, help="只扫单个文件")
    ap.add_argument("--selftest", action="store_true", help="只跑规则自检，不扫文件")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    if args.file:
        paths = [args.file]
    elif args.all:
        paths = list(walk_files())
    else:
        paths = tracked_files()

    print("项目根：%s" % BASE_DIR)
    print("扫描 %d 个路径 ..." % len(paths))
    scanned, problems = audit(paths)

    print("实际读取 %d 个文本文件" % scanned)
    print("")
    if problems:
        for p in problems:
            print("  [X] %s" % p)
        print("")
        print("体检查出 %d 处问题 —— 拒绝上传。" % len(problems))
        return 1

    print("  无 SteamID64（公开基准 / 公开账号名单除外）、无 32 位十六进制串、无本机绝对路径")
    print("")
    print("体检通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
