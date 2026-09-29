# -*- coding: utf-8 -*-
"""
MyGameVaultList —— Windows 桌面版启动器（离线）。

做三件事：
  1. 设 `GV_DESKTOP=1`（**必须在 import config 之前** —— 那个开关是导入期读环境变量的）
  2. 在后台线程里起 `server/app.py` 的 HTTP 服务，**只绑 127.0.0.1 + 系统分配的空闲端口**
  3. 开一个 pywebview 窗口指向 `http://127.0.0.1:<port>/`

## 为什么还留着一个 HTTP 服务（而不是纯前端 + file://）

前端一堆 `fetch('/api/steam/…')` 是**相对路径**，同源才没有 CORS 问题；
桌面版把数据源换成 `/api/local/*` 就行，改动量远小于重写前端。
而且这个回环服务**本来就存在**，只是原来只跑在部署环境里。

## 🔴 四条不能动的约定

1. **只绑 `127.0.0.1`** —— 不监听 `0.0.0.0`，局域网内别的机器连不上。
2. **端口固定**（`DEFAULT_PORT`），**不是随机**。
3. `GV_DESKTOP=1` 才会注册 `/api/local/*`（读本机 Steam 的个人数据）。
   本文件是**唯一**该设这个变量的地方；线上部署永不设 → 那些路由根本不存在。
4. 🔴🔴 **开窗必须带 `private_mode=False` + 固定 `storage_path`**
   （`webview_data_dir()`，见该函数的说明）—— 少了任一个，用户存的数据
   **关掉窗口就没了**。这条与第 2 条是一对：端口固定管住了浏览器那一路的「源」，
   这条管住 WebView2 自己那套存储。<br>
   冻结（出 exe）后还有一条同源的：**资源根用 `sys._MEIPASS`**，不是 `__file__` 上跳两层。

## 🔴🔴 为什么端口必须固定（别改回 `port=0`）

浏览器存储（localStorage / IndexedDB）是按**源**隔离的，而**源里含端口**：

    http://127.0.0.1:11699   ← 一个源
    http://127.0.0.1:11700   ← 另一个源，看不到上面那个源的数据

原来用 `port=0`（系统分配空闲端口）时，**每次启动端口都不同 → 每次都换源**，
于是游戏库、状态归类、感想、偏好、消息历史**全部在重启后消失**。
实测（`_probe_origin.py`，同一个 Chrome profile）：连起两次得到 11699 / 11700；
在 `:11701` 写入 `written@11701`，到 `:11730` 读回 `None`。

所以：**固定端口 = 固定源 = 数据能留住**。
代价是「可能撞端口」，用下面两条兜住：
  · 撞上的是**我们自己的另一个实例** → 直接连上去（单实例，不再起第二个服务）；
  · 撞上的是**别的程序** → 明确报错并给换端口指引（不偷偷换端口，那等于偷偷清空用户数据）。

    python desktop/main.py                正常启动（开窗口，用默认固定端口）
    python desktop/main.py --serve        只起服务、打印地址，不开窗（排错 / 自动化验收）
    python desktop/main.py --browser      用系统默认浏览器打开（没装 pywebview 时的降级）
    python desktop/main.py --port=8080    指定端口
                                          ⚠️ 换端口 = 换源 = 之前存在浏览器里的数据看不见了
    python desktop/main.py --port=0       随机端口：**只给自动化测试隔离用**，不要给用户用
"""

import json
import os
import sys
import threading
import time
import urllib.request
import webbrowser

# 🔴 资源根目录：开发期与**冻结（PyInstaller）后**算法不同，不能合并。
#
# 开发期：本文件在 `<项目>/desktop/main.py` → 上跳两层就是项目根。
# 冻结后：PyInstaller 把入口脚本当顶层模块 `__main__` 放进解包目录，
#         `__file__` 变成 `<解包根>/main.py` —— **desktop/ 这一层不存在**，
#         于是 `dirname(dirname(...))` 会指到解包根的**父目录** → `server/` 找不到
#         → `import app` 直接失败，exe 一启动就崩。
#         解包根的真身在 `sys._MEIPASS`。
if getattr(sys, "frozen", False):
    ROOT = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
else:
    ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

# 🔴 固定端口（见文件头「为什么端口必须固定」）。选一个大号高位端口，避开常见服务。
DEFAULT_PORT = 47615

# 🔴 顺序要紧：config.DESKTOP_MODE 是**导入期**读的环境变量，
#    这行必须在下面 import app（进而 import config）之前。
os.environ["GV_DESKTOP"] = "1"

import app as gv_app              # noqa: E402  (server/app.py)
import steam_local                # noqa: E402

WINDOW_TITLE = "MyGameVaultList"


def is_our_service(port, timeout=1.5):
    """端口上跑的是不是**我们自己**的一个实例？

    判据是 `/api/local/status` 回 `desktop: true` —— 只有设了 `GV_DESKTOP=1`
    的进程才注册那个路由，所以别的程序不可能冒充。
    """
    try:
        with urllib.request.urlopen(
                "http://127.0.0.1:%d/api/local/status" % port, timeout=timeout) as r:
            return bool(json.loads(r.read().decode("utf-8")).get("desktop"))
    except Exception:
        return False


def start_link(host="127.0.0.1", port=DEFAULT_PORT):
    """起回环服务；端口已被**自己**占着就改连上去。

    返回 `(server, url, attached)`：
      · `attached=False` → `server` 是本进程新起的服务（退出时要关）。
      · `attached=True`  → 端口上已有我们的实例，`server` 为 None，直接用它。

    端口被**别的程序**占用时抛 `OSError`，由调用方给用户明确指引 ——
    绝不静默换端口（那会让用户以为"数据没了"）。

    🔴 **必须先探再绑，不能靠「bind 失败」来发现重复实例**：
    Windows 的 `SO_REUSEADDR` 语义与 Unix 不同 —— 它允许绑定别人已占用的端口。
    实测：第一个实例在 47615 上服务时，第二个实例 `bind(47615)` **照样成功**，
    于是「撞端口」永远不会抛错，两个服务一起抢同一个端口的连接
    （回归断言 `L3b` 就是这么抓到它的）。
    """
    if port and is_our_service(port):
        return None, "http://%s:%d/" % (host, port), True
    server = gv_app.build_server(host, port)
    t = threading.Thread(target=server.serve_forever, name="gv-http", daemon=True)
    t.start()
    real_host, real_port = server.server_address[:2]
    return server, "http://%s:%d/" % (real_host, real_port), False


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
    opts = {"port": DEFAULT_PORT, "mode": "window"}
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


def webview_data_dir():
    """WebView2 的用户数据目录（localStorage / IndexedDB 真正落盘的地方）。

    与 `desktop.json`（`steam_local.settings_path()`）同根：默认
    `%LOCALAPPDATA%\\MyGameVault\\webview`，`GV_DESKTOP_HOME` 可整体改（测试用）。

    🔴🔴 为什么必须显式传（别退回 `webview.start()` 裸调用）

    pywebview 的 `start()` 签名默认是 `private_mode=True` + `storage_path=None`，
    Windows 后端（`webview/platforms/winforms.py::init_storage`）遇到这个组合会走：

        cache_dir = tempfile.TemporaryDirectory().name      # 每次启动一个随机临时目录

    再叠上 `edgechromium.py` 的 `props.set_IsInPrivateModeEnabled(True)`
    → WebView2 进 InPrivate，且 user data folder 每个进程都换。
    两头一起 → **存的库 / 归类 / 感想 / 偏好 / 消息，关掉窗口全丢**。

    也就是说「固定端口 = 固定源 = 数据留住」这条教训，**只管住了浏览器那一路；
    pywebview 这条路上它从来没生效过** —— 因为 WebView2 自带一套存储，
    与端口无关。所有持久化验证此前都跑在无头 Chrome 上（`_t_desktop_launch.py`），
    pywebview 是验证盲区。

    所以这里两个参数缺一不可：
      · `private_mode=False` → 允许落盘（否则同在固定目录里也照样丢）；
      · `storage_path=<固定目录>` → 目录固定（否则每次随机 = 每次都换一份存储）。
    """
    home = os.environ.get("GV_DESKTOP_HOME") or ""
    if not home:
        home = os.path.join(os.environ.get("LOCALAPPDATA")
                            or os.path.expanduser("~"), "MyGameVault")
    return os.path.join(home, "webview")


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
        data_dir = webview_data_dir()          # 见上面的说明，这两个参数缺一不可
        print("数据目录：%s" % data_dir)

        # ⚠️ 仅自动化验收 / 排错用：打开 WebView2 的远程调试端口，让外部脚本
        #    能读写页面里的存储 —— `_e2e_desktop_exe.py` 靠它验「关掉重开数据还在」。
        #    不设这个环境变量时行为**完全不变**。
        dbg = os.environ.get("GV_WEBVIEW_DEBUG_PORT", "").strip()
        if dbg:
            try:
                webview.settings["REMOTE_DEBUGGING_PORT"] = int(dbg)
                print("调试端口：%s（仅验收/排错用）" % dbg)
            except ValueError:
                print("GV_WEBVIEW_DEBUG_PORT 得是数字，收到 %r —— 已忽略。" % dbg)

        webview.start(private_mode=False, storage_path=data_dir)
    except Exception as e:
        print("窗口启动失败（%r）—— 降级为系统浏览器打开。" % (e,))
        webbrowser.open(url)
        block_forever()


def main(argv=None):
    opts = parse_args(sys.argv[1:] if argv is None else argv)
    port = opts["port"]

    try:
        server, url, attached = start_link("127.0.0.1", port)
    except OSError as e:
        # 🔴 不偷偷换端口：换端口会让浏览器换源，用户会以为「我存的数据全没了」。
        #    宁可停在这里说清楚，让他自己决定关掉谁。
        print("=" * 56)
        print("🔴 端口 %d 被别的程序占用了（%s）" % (port, e))
        print("这个端口不能随便换 —— 浏览器按「端口」隔离本机数据，")
        print("换端口 = 换一份存储 = 之前保存的库 / 状态 / 感想会看不见。")
        print("请先关掉占用 %d 的程序，再重新启动。" % port)
        print("确实需要换：python desktop/main.py --port=<另一个端口>")
        print("（换了以后数据要从头同步一遍；旧的并没有被删，换回端口就还在。）")
        print("=" * 56)
        return 3

    print("=" * 56)
    print("MyGameVaultList · 桌面版（离线）")
    print("本机地址：%s" % url)
    print("监听范围：仅本机回环（127.0.0.1）—— 局域网内别的机器连不上")
    if attached:
        print("已在运行：端口上已有本程序的一个实例，直接连上它（共用同一份本机数据）")
    print("=" * 56)
    if attached:
        print("（另一个窗口里的数据就在这里，不需要再同步一遍。）")
    else:
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
        if server is not None:
            server.shutdown()
            server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
