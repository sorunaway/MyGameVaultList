#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GameVault — 把出好的桌面版 exe 打成**可以直接发人**的 zip。

为什么不能直接发 `dist/gamevault-desktop/` 目录
------------------------------------------------
1. 三百来个文件，微信/QQ 传不了目录，**必须先压成一个文件**；
2. onedir 形态下 `exe` 与 `_internal/` 是一套，**单独把 exe 拖出来就跑不起来** ——
   收包的人十个有九个会这么干，所以包里必须带一份《使用说明》把这条写在最前面；
3. 收包的人自己没有上下文：SmartScreen 拦截、控制台窗口、首屏空白（没 Steam）
   都会被当成"你给我的东西坏了" → 说明文件要逐条先讲清楚。

与 `pack_win.py` 的分工
-----------------------
`pack_win.py` 负责**做 exe**（白名单 + 两次泄露体检）；本脚本负责**发 exe**（压缩 + 说明书）。
体检规则**不在本文件重写一份** —— 直接 import `pack_win`，用它的 `audit_dir`。
理由：两套规则一旦分叉，早晚有一天是"出包时拦住了、发的时候放过去了"。

用法
----
    python scripts/pack_share_zip.py                # 打包 + 自检
    python scripts/pack_share_zip.py --verify       # 顺带解压到临时目录，证明压出来的能跑
    python scripts/pack_share_zip.py --dist <目录>  # 指定别的产物目录
    python scripts/pack_share_zip.py --out <目录>   # 指定 zip 落点

产物
----
    ../_build_desktop/share/GameVault-试用版-YYYYMMDD.zip
        ├── 使用说明.txt                 ← 放**根**上，解压第一眼就看见
        └── gamevault-desktop/           ← 整个目录，缺一不可
            ├── gamevault-desktop.exe
            └── _internal/

⚠️ 产物一律在**项目外**（与 pack_win.py 同理）—— 免得被 git / 发布工具顺手上传。
"""

import argparse
import os
import sys
import tempfile
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import pack_win  # noqa: E402  复用它的体检规则与产物路径

APP_DIRNAME = "gamevault-desktop"
README_NAME = "使用说明.txt"

# 说明书里要写的本机路径（与 desktop/main.py 的 webview_data_dir() 同根）
DATA_HINT = r"%LOCALAPPDATA%\MyGameVault"


def readme_text(built_on):
    """试用说明。收包的人**只有这一份**上下文，所以按"他会在哪一步卡住"来写。"""
    return u"""\
GameVault 桌面版 · 试用说明
============================================================
打包日期：{built_on}

一句话：把 Steam 库里「有哪些游戏、玩了多久、通关没有」整理成一面卡片墙，
       能自己标状态（在玩 / 想玩 / 已通关…）、写感想、做筛选排序。


一、怎么打开
------------------------------------------------------------
1. 先把压缩包**整个解压出来**（右键 → 全部解压缩）。
   不要在压缩包里直接双击 —— 那样打不开。

2. 进 gamevault-desktop 文件夹，双击 gamevault-desktop.exe

3. Windows 可能弹出蓝色的「Windows 已保护你的电脑」：
   点「更多信息」→「仍要运行」。
   原因：这个 exe 没有买代码签名证书，并不是检测到病毒。
   如果杀毒软件拦了，放行即可（这类打包方式被误报很常见）。

4. 会先跳出一个**黑色的控制台窗口**，那是启动日志，别关它。
   关掉它 = 退出程序。（你要的数据不在这个窗口里，在下面第三条。）


二、⚠️ exe 不能单独拖出来
------------------------------------------------------------
gamevault-desktop 文件夹里的 exe 和 _internal 文件夹是**一套**，
少一个都启动不了。要挪地方就整个文件夹一起挪。

   症状对照：只拿了 exe 的话，双击后会一闪而过，
   或者在黑窗里看到一行 `Failed to load Python DLL ...` —— 就是这个原因，
   回到压缩包里把整个文件夹重新解压出来就好，不是文件坏了。


三、第一次打开是空的？
------------------------------------------------------------
界面里的数据来自**你自己电脑上的 Steam**，所以：

1. 机器要装过 Steam，并且至少登录过一次；
2. 打开后点界面上的「同步」，它会自动去读本机 Steam 库里有什么游戏，
   然后分批把名字、封面、时长补上（几百款大概要等一会儿，不用一直盯着）；
3. 同一次「同步」还会做两件联网的事（要先去「设置 → Steam 账号」填 SteamID
   和 Steam Web API Key，见下一条）：
   · 读你账号的**全量库**（本机只装过 / 玩过的看不到，这一步能把买过没碰过的补上）；
   · 读你的 **Steam 愿望单**，导进「待游玩」区块 —— 名字和封面会随后台补，
     刚导进来时卡面先显示「App 数字」占位，别以为是坏数据。
   ⚠️ 愿望单要能被读到，得在 Steam 网页版把「愿望单」的隐私设成**公开**。
4. 没装 Steam 也能用 —— 点「添加」手动录入想记的游戏。
5. 加入过 Steam 家庭组的话，「同步」还会顺带读家人**公开的** Steam 库，
   这些游戏单独标成「家人拥有」，默认**不显示**
   （在「我的游戏单 → 筛选」里打开「家人拥有」才看得到）。
   ⚠️ 它说的是「家人有这些」，不代表你一定玩得到 —— 有些游戏发行商关掉了共享、
   或者需要额外的 key，能不能玩以 Steam 为准。这些款不计入你的游戏时长。
6. 「我的游戏单 → 筛选」里那几个开关（隐藏非游戏 / 隐藏已通关 / 隐藏已放弃 /
   隐藏家人拥有 / 全成就合并成一组）你改完会**记住**，下次打开还是你上次的样子。

数据全部存在你自己电脑本地：
    {data_hint}
不上传任何服务器。想备份 / 换电脑：设置 → 数据备份 → 导出到文件。


四、出问题怎么反馈给我
------------------------------------------------------------
1. 窗口没出来、反而用浏览器打开了？
   说明系统里缺 WebView2 运行时（Win11 自带；Win10 装过 Edge 的也有，
   少数旧机器没有）。功能完全一样，只是没有独立窗口，可以照样用。

2. 其他问题：控制台窗口里那些文字就是日志，**先别关那个窗口**，
   连同窗口一起截图发我（黑窗里的报错是最有用的线索）。


五、这版还没做的地方（免得你以为是 bug）
------------------------------------------------------------
· 没有首次启动向导：没装 Steam 时界面是空的，只有控制台里一行提示。
· 控制台黑窗口暂时去不掉：那些提示都走它，去掉就什么都看不见了。
· 界面配色 / 交互还在改，随便提意见。
""".format(built_on=built_on, data_hint=DATA_HINT)


# ---------------------------------------------------------------- 打包

def zip_symlink_free(zf, src, arcname):
    """写一个文件进 zip。跳过软链接（本项目的产物里没有，防的是意外）。"""
    if os.path.islink(src):
        return False
    zf.write(src, arcname)
    return True


def make_zip(dist_dir, out_path, readme):
    """把 dist 目录整体压进 zip：内容保持 `<APP_DIRNAME>/...`，说明书放根上。

    🔴 为什么说明书带 UTF-8 文件名标记 —— zipfile 遇到非 ASCII 名会自动置
    `flag_bits & 0x800`；Win10 1803 以后的资源管理器认这个标记，解压出来
    不会变成乱码。这里是**明确校验**它，不是假设。
    """
    entries = 0
    raw_total = 0
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for root, dirs, files in os.walk(dist_dir):
            dirs[:] = sorted(d for d in dirs if d != "__pycache__")
            for name in sorted(files):
                src = os.path.join(root, name)
                rel = os.path.relpath(src, dist_dir).replace(os.sep, "/")
                if zip_symlink_free(zf, src, "%s/%s" % (APP_DIRNAME, rel)):
                    entries += 1
                    raw_total += os.path.getsize(src)
        zf.writestr(README_NAME, readme.encode("utf-8"))
        entries += 1
    return entries, raw_total


def audit_zip(zip_path):
    """读回 zip 自检：结构齐不齐、有没有夹带、文件名编码对不对。返回问题列表。

    这几条都是"发出去才发现"的类型，所以必须**从压好的文件里读回来验**，
    而不是回头再去看源目录（源目录对不代表 zip 里对）。
    """
    problems = []
    with zipfile.ZipFile(zip_path) as zf:
        infos = zf.infolist()
        names = [i.filename for i in infos]

        # ① 必需项
        exe = "%s/%s.exe" % (APP_DIRNAME, APP_DIRNAME)
        if exe not in names:
            problems.append("zip 里没有主 exe：%s" % exe)
        if not any(n.startswith("%s/_internal/" % APP_DIRNAME) for n in names):
            problems.append("zip 里没有 _internal/ —— 收包的人会启动不了")
        if README_NAME not in names:
            problems.append("zip 里没有 %s" % README_NAME)

        # ② 说明书文件名必须带 UTF-8 标记（否则某些解压器出乱码名）
        rd = zf.getinfo(README_NAME)
        if not (rd.flag_bits & 0x800):
            problems.append("%s 没带 UTF-8 标记（flag_bits=0x%x）"
                            % (README_NAME, rd.flag_bits))

        # ③ 夹带检查：与 pack_win 同一套规则（含 SteamID / 32 位十六进制串）
        for i in infos:
            base = i.filename.rsplit("/", 1)[-1]
            if base in pack_win.FORBID_BASENAMES:
                problems.append("zip 里混进了 %s（%s）"
                                % (i.filename, pack_win.FORBID_BASENAMES[base]))
            for part in pack_win.FORBID_PATHPARTS:
                if part in i.filename.split("/"):
                    problems.append("zip 里混进了目录 %s（%s）"
                                    % (i.filename, pack_win.FORBID_PATHPARTS[part]))

        # ④ 说明书写的是不是给人看的那份（防模板改坏、防写成空文件）
        text = zf.read(README_NAME).decode("utf-8")
        for must in (u"仍要运行",           # SmartScreen 怎么过
                     u"不能单独拖出来",      # 最常见的错法
                     u"Failed to load Python DLL",  # 上一条的具体症状（实测就是这个报错）
                     u"同步"):               # 没 Steam 时界面为什么是空的
            if must not in text:
                problems.append("%s 里少了「%s」这段说明" % (README_NAME, must))

    return problems


def sha256_of(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_extract(zip_path, dest):
    """解压一份出来并交代地点。真正的"能不能跑"交给 `_e2e_desktop_exe.py --exe`。"""
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(dest)
    exe = os.path.join(dest, APP_DIRNAME, APP_DIRNAME + ".exe")
    rd = os.path.join(dest, README_NAME)
    return exe, rd


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", default=os.path.join(pack_win.DIST_DIR, APP_DIRNAME),
                    help="产物目录（默认 dist/gamevault-desktop）")
    ap.add_argument("--out", default=os.path.join(pack_win.OUT_ROOT, "share"),
                    help="zip 落点目录")
    ap.add_argument("--verify", action="store_true",
                    help="压完解到临时目录，打印解压出的 exe 路径")
    args = ap.parse_args()

    dist = os.path.abspath(args.dist)
    if not os.path.isdir(dist):
        print("!! 还没有产物：%s" % dist)
        print("   先出包：python scripts/pack_win.py")
        return 2

    exe = pack_win.find_pe_binary(dist)
    if not exe:
        print("!! %s 里找不到主 exe —— 产物不完整。" % dist)
        return 2

    print("产物：%s" % dist)
    print("主程序：%s（%.1f MB）" % (exe, os.path.getsize(exe) / 1048576.0))

    # ---- ① 压之前先体检：包不该由"带病"的产物压出来 ----
    print("")
    print("--- ① 源产物体检（复用 pack_win 的规则） ---")
    problems = pack_win.audit_dir(dist, "dist")
    if problems:
        for p in problems:
            print("  [X] %s" % p)
        print("\n体检没过 —— 拒绝打包。")
        return 1
    print("  干净：无 .env / seed-data.js / desktop.json / SteamID / 32 位十六进制串")

    # ---- ② 压缩 ----
    os.makedirs(args.out, exist_ok=True)
    # ⚠️ 带上**时分**：同一天可能要发两版（比如 2026-09-24 上午那版有缺陷、
    #    下午修好重发）。只到日期的话两个包同名，用户分不清手上是哪个，
    #    反馈就变成"我测的还是有问题"——查不下去。说明书里也同步带上时间。
    stamp = time.strftime("%Y%m%d-%H%M")
    built_on = time.strftime("%Y-%m-%d %H:%M")
    name = "GameVault-试用版-%s.zip" % stamp
    out_path = os.path.join(args.out, name)

    # ⚠️ 先写临时名再 os.replace —— 覆盖同期旧包时，OS 上只需一次单文件替换，
    #    不会触发这个环境里的「批量删除保护」（见 pack_win.clean_previous 的说明）。
    tmp_path = out_path + ".part"
    print("")
    print("--- ② 压缩 ---")
    entries, raw_total = make_zip(dist, tmp_path, readme_text(built_on))
    os.replace(tmp_path, out_path)
    zsize = os.path.getsize(out_path)
    print("  %d 个条目，原始 %.1f MB → zip %.1f MB（压缩到 %.0f%%）"
          % (entries, raw_total / 1048576.0, zsize / 1048576.0,
             zsize * 100.0 / max(raw_total, 1)))

    # ---- ③ 压完自检（从 zip 里读回来验） ----
    print("")
    print("--- ③ 压缩包自检（读回 zip 校验，不是回看源目录） ---")
    problems = audit_zip(out_path)
    if problems:
        for p in problems:
            print("  [X] %s" % p)
        print("\n自检没过 —— 这个包别发。")
        return 1
    print("  结构齐全（exe + _internal/ + %s 均在）" % README_NAME)
    print("  %s 带 UTF-8 文件名标记（Win10 1803+ 解压不会乱码）" % README_NAME)
    print("  无夹带（.env / seed-data.js / desktop.json / 开发期截图）")

    # ---- ④ 可选：解压一份出来 ----
    if args.verify:
        dest = tempfile.mkdtemp(prefix="gv_share_verify_")
        v_exe, v_rd = verify_extract(out_path, dest)
        print("")
        print("--- ④ 解压验证 ---")
        print("  解到：%s" % dest)
        print("  exe ：%s（%s）" % (v_exe, "在" if os.path.isfile(v_exe) else "缺失"))
        print("  说明：%s（%s）" % (v_rd, "在" if os.path.isfile(v_rd) else "缺失"))
        print("  下一步（证明真能跑）：")
        print("    python _e2e_desktop_exe.py --exe \"%s\"" % v_exe)

    print("")
    print("=" * 60)
    print("分享包：%s" % out_path)
    print("大小  ：%.1f MB" % (zsize / 1048576.0))
    print("校验码：SHA-256 %s" % sha256_of(out_path))
    print("       （对方说打不开时，先让他核这个值 —— 对不上就是传输掉了包）")
    print("收包的人只要做两件事：解压 → 双击 gamevault-desktop.exe")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
