# -*- coding: utf-8 -*-
"""
我的游戏生涯 — 服务端配置

优先级：环境变量 > 项目根 .env 文件 > 内置默认值。

安全约定：STEAM_API_KEY 只允许存在于服务端。
它会在服务端进程的内存里被使用，永远不会出现在任何 /api/ 响应里，
也永远不会写进前端文件。
"""

import os
import sys

# 🔴 全项目**唯一**的路径锚点（`WEB_DIR` 就是它，静态文件服务靠它找 index.html/css/js）。
#    冻结（PyInstaller）后算法不同，不能沿用 `__file__` 上跳两层：
#      · 开发期：本文件在 `<项目>/server/config.py` → 上跳两层 = 项目根 ✅
#      · 冻结后：本模块被编译进 PYZ，`__file__` 由 FrozenImporter **按模块名**拼成
#        `<_MEIPASS>/config.py` —— 注意**没有 `server/` 这一层**（模块名就叫 `config`，
#        不是 `server.config`）→ `dirname(dirname(...))` 会跑到解包目录的**父目录**
#        → 静态文件全部 404，exe 打开是白屏。真身在 `sys._MEIPASS`。
#    ⚠️ 别用「把 server/ 当数据文件打进去」来绕：PYZ 里的模块优先于文件系统，
#       `__file__` 仍然指向 `_MEIPASS/config.py`，绕不过去。
if getattr(sys, "frozen", False):
    BASE_DIR = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
else:
    BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(BASE_DIR, ".env")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")


def _read_env_file(path):
    """极简 .env 解析：KEY=VALUE，忽略空行与 # 注释。不引第三方依赖。"""
    out = {}
    if not os.path.exists(path):
        return out
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    except Exception:
        pass
    return out


_ENV = _read_env_file(ENV_PATH)


def get(name, default=""):
    """环境变量优先，其次 .env，最后默认值。"""
    v = os.environ.get(name)
    if v:
        return v
    v = _ENV.get(name)
    if v:
        return v
    return default


# ===== 服务 =====
PORT = int(get("PORT", "3000"))

# Steam Web API Key —— 服务端专用
STEAM_API_KEY = get("STEAM_API_KEY", "")

# 公网基地址（用于拼 OpenID 的 return_to / realm）。
# 留空则按请求的 Host 头自动推断，部署到哪个域名都不用改配置。
PUBLIC_BASE = get("PUBLIC_BASE", "").rstrip("/")

# ---------------------------------------------------------------
# 本机模式开关（Windows 桌面版）
#
# 只有桌面版启动器会设 GV_DESKTOP=1。置真时 server/app.py 才会注册
# /api/local/* 那组路由 —— 它们读的是**本机 Steam 的个人数据**（安装路径、
# 账号、游戏库、时长、封面）。
#
# 🔴 线上部署永远不会设这个变量 → 那些路由根本不注册 → 外部访问得到 404。
#    这是「个人数据不出本机」的**唯一**闸门，别改成非环境变量的判定。
# ---------------------------------------------------------------
DESKTOP_MODE = get("GV_DESKTOP", "").strip() == "1"

# ===== 静态资源 =====
WEB_DIR = BASE_DIR

# 只允许这些路径被静态服务读取 —— 避免 server/ 源码与 data/ 数据被下载
#
# ⚠️ screenshots/ 故意不在这里：那些图是开发期的截图，内容包含**个人游戏库**。
#    应用本体有登录门，但静态文件不走登录，放进来等于开了个绕过登录的
#    后门（任何知道 URL 的人都能下）。要公开某张图就单独往 assets/ 放。
#
# ⚠️ 这是**名单制**：新增一个静态目录（比如 vendor/）必须在这里登记，
#    否则线上 404。而本地双击 index.html 时不经过这个服务端，
#    所以本地测一切正常、只有线上挂 —— 改完务必用线上 curl 验一次。
STATIC_DIRS = ("css", "js", "assets", "vendor")
STATIC_FILES = ("index.html", "favicon.ico", "manifest.webmanifest",
                "sw.js", "robots.txt")

# 白名单之外再单独拦掉的文件（路径相对于项目根）。
#
# js/seed-data.js 是本地双击版用来灌初始数据的，内容就是**完整的个人游戏库**
# （含手写笔记）。它躺在白名单目录 js/ 里，不单独拦掉的话，
# 任何人都能 GET /js/seed-data.js 把你的库整个下走。
# 云端版根本用不到它，本地版走 file:// 也不经过这个服务端，所以直接禁掉最省事。
#
# vendor/README.md 是给维护者看的升级说明（包名、版本、哈希、步骤）。
# 它无害但对外毫无价值，反而白送一份技术栈清单 ——
# 目录一旦进白名单就是**整个目录**开放，所以这类文档要单独拦。
STATIC_DENY = ("js/seed-data.js", "vendor/README.md")

# ===== Steam =====
STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login"
API = "https://api.steampowered.com"
STORE_API = "https://store.steampowered.com/api/appdetails"

# ⚠️ 2026-09-20 实测纠正：这里原来写的是「Steam 官方限制约 1 请求/秒」，**那是错的**。
#    1 请求/秒是 **store.steampowered.com（商店网页接口）** 的社区经验值，
#    被错记到 Web API 头上，还成了下面这个间隔的依据 —— 而它按**全局串行**生效
#    （同一时刻只允许一个请求在飞），把成就扫描拖成"每轮 60 款、要跑 4~6 次"。
#    实测真相：api.steampowered.com 是**每 key 每天 10 万次**的软配额，官方未公布每秒上限；
#    并发 32 跑完全库只要 **15.0 秒、零 429**（累计压测 4000+ 次请求一次 429 都没出现）。
#    完整数据见 .workbuddy/memory/DESIGN.md 的「Steam 限流实测」一节。
#
# 所以这个间隔降为 0。礼貌性限速改由「在飞请求数上限」承担 —— 需要设防的维度是
# **并发度**，不是**两次请求之间的间隔**：间隔限的是总量，并发限的才是瞬时压力。
STEAM_MIN_INTERVAL = 0.0

# 同时在飞的 Steam Web API 请求数上限（成就批量扫描的 worker 数）。
#
# ⚠️ 这个数是**实测**定的，不是拍的。同一批 120 款真实游戏、只换 worker 数：
#
#   workers   耗时      吞吐
#   8         28.6s     4.2 款/秒
#   12        18.4s     6.5 款/秒
#   16        15.5s     7.7 款/秒   ← 拐点
#   24        16.3s     7.4 款/秒
#   32        23.1s     5.2 款/秒   ← 反而变慢
#
# 16 之后再加 worker 只会让跨境链路更拥塞，吞吐反降。
# 这和「Steam 侧不限制并发」并不矛盾：**瓶颈是链路，不是 Steam 的限流** ——
# 上限压不到 Steam 头上，压到我们自己这一侧的出口带宽了。
STEAM_MAX_CONCURRENCY = 16

# 商店接口单独用更短的间隔 —— 它和 Web API 不是一回事：
#   · api.steampowered.com  是有配额的 Web API（0.8 秒那条约束针对它）
#   · store.steampowered.com 是公开的网页接口，浏览器打开一个商店页
#     就会带出一堆并发请求，限流宽松得多
# 商店信息是「一款一次」的（批量拼 appids 会被 400 拒绝，实测过），
# 400 多款游戏用 0.8 秒节流要跑 5 分钟以上 —— 那是手机浏览器会把
# 后台标签页冻死的量级。所以这里放到 0.3 秒，既快又仍在礼貌范围内。
STORE_MIN_INTERVAL = 0.3

# 商店接口的 filters 参数 —— 留空，**不要**用 basic。
#
# 曾经为了减小响应体改成 basic，实测被反咬：basic **恰好砍掉了我们要的字段**，
# 返回的 data 里只剩 name 和 header_image，
# release_date / genres / developers 全没了（线上实测 570 -> release=null, genres=[]）。
# 也就是说它省掉的那些「体积」里，正包含发售年份和游戏类型。
# 完整响应约 4 KB，可以接受 —— 用体积换掉功能不划算。
STORE_FILTERS = ""
