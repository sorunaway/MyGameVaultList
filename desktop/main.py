# -*- coding: utf-8 -*-
"""
我的游戏生涯 —— Windows 桌面版启动器（离线）。

做三件事：
  1. 设 `GV_DESKTOP=1`（**必须在 import config 之前** —— 那个开关是导入期读环境变量的）
  2. 在后台线程里起 `server/app.py` 的 HTTP 服务，**只绑 127.0.0.1 + 系统分配的空闲端口**
  3. 开一个 pywebview 窗口指向 `http://127.0.0.1:<port>/`

## 为什么还留着一个 HTTP 服务（而不是纯前端 + file://）

前端一堆 `fetch('/api/steam/…')` 是**相对路径**，同源才没有 CORS 问题；
桌面版把数据源换成 `/api/local/*` 就行，改动量远小于重写前端。
而且这个回环服务**本来就存在**，只是原来只跑在部署环境里。

## 🔴 两个安全约定

1. **只绑 `127.0.0.1`，端口交给系统分配（`port=0`）** —— 不监听 `0.0.0.0`，
   局域网内别的机器连不上；端口随机，也不会跟别的程序抢 3000。
2. `GV_DESKTOP=1` 才会注册 `/api/local/*`（读本机 Steam 的个人数据）。
   本文件是**唯一**该设这个变量的地方；线上部署永不设 → 那些路由根本不存在。

## 用法

    python desktop/main.py            正常启动（开窗口）
    python desktop/main.py --serve    只起服务、打印地址，不开窗（排错 / 自动化验收）
    python desktop/main.py --browser  用系统默认浏览器打开（没装 pywebview 时的降级）
    python desktop/main.py --port=8080  指定端口（默认 0 = 系统分配）
"""

import os
import sys
import threading
import time
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

# 🔴 顺序要紧：config.DESKTOP_MODE 是**导入期**读的环境变量，
#    这行必须在下面 import app（进而 import config）之前。
os.environ["GV_DESKTOP"] = "1"

import app as gv_app              # noqa: E402  (server/app.py)
import steam_local                # noqa: E402

WINDOW_TITLE = "我的游戏生涯"


def start_server(host="127.0.0.1", port=0):
    """起一个回环服务线程，返回 (server, url)。server 用来读真实端口、退出时关掉。"""
    server = gv_app.build_server(host, port)
    t = threading.Thread(target=server.serve_forever, name="gv-http", daemon=True)
    t.start()
    real_host, real_port = server.server_address[:2]
    return server, "http://%s:%d/" % (real_host, real_port)


def startup_report():
    """开机自检：Steam 在不在、当前账号是谁。**只读小文件，不扫库**（扫库交给前端）。"""
    steam_dir = steam_local.find_steam()
    if not steam_dir:
        print("⚠️  没找到 Steam 安装目录 —— 界面会是空的。")
        print("    确认：Steam 装过、并且至少登录过一次（本程序只读它的本地文件）。")
        return
    print("Steam 目录：%s" % steam_dir)
    accounts = steam_local.read_accounts(steam_dir)
    if not accounts:
        print("⚠️  读不到已登录账号（config/loginusers.vdf 为空）—— 请先登录一次 Steam。")
        return
    me = accounts[0]
    print("当前账号：%s（%s）%s"
          % (me["personaName"] or me["accountName"], me["accountName"],
             "，本机共 %d 个账号" % len(accounts) if len(accounts) > 1 else ""))


def parse_args(argv):
    """极简参数解析（不引 argparse 之外的东西，保持零依赖观感）。"""
    opts = {"port": 0, "mode": "window"}
    for a in argv:
        if a.startswith("--port="):
            try:
                opts["port"] = int(a.split("=", 1)[1])
            except ValueError:
                print("--port= 后面要跟数字，收到：%s" % a)
                raise SystemExit(2)
        elif a == "--serve":
            opts["mode"] = "serve"
        elif a == "--browser":
            opts["mode"] = "browser"
        elif a in ("-h", "--help"):
            print(__doc__)
            raise SystemExit(0)
        else:
            print("不认识的参数：%s（-h 看用法）" % a)
            raise SystemExit(2)
    return opts


def block_forever():
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


def open_window(url):
    """开 pywebview 窗口；装不上/起不来就降级用系统浏览器，不让用户啥也看不到。"""
    try:
        import webview
    except ImportError:
        print("未装 pywebview —— 降级为系统浏览器打开（功能一样，只是没有独立窗口）。")
        print("想用独立窗口：pip install pywebview")
        webbrowser.open(url)
        block_forever()
        return
    try:
        # Windows 上会自动挑 Edge WebView2（本机已装运行时，不需要用户额外装东西）
        webview.create_window(WINDOW_TITLE, url,
                              width=1280, height=860, min_size=(900, 600))
        webview.start()
    except Exception as e:
        print("窗口启动失败（%r）—— 降级为系统浏览器打开。" % (e,))
        webbrowser.open(url)
        block_forever()


def main(argv=None):
    opts = parse_args(sys.argv[1:] if argv is None else argv)

    server, url = start_server("127.0.0.1", opts["port"])
    print("=" * 56)
    print("我的游戏生涯 · 桌面版（离线）")
    print("本机地址：%s" % url)
    print("监听范围：仅本机回环（127.0.0.1）—— 局域网内别的机器连不上")
    print("=" * 56)
    startup_report()
    print("-" * 56)

    try:
        if opts["mode"] == "serve":
            print("--serve：只起服务，不开窗。按 Ctrl+C 退出。")
            block_forever()
        elif opts["mode"] == "browser":
            webbrowser.open(url)
            print("已用系统浏览器打开。按 Ctrl+C 退出。")
            block_forever()
        else:
            open_window(url)
            print("窗口已关闭，退出。")
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
