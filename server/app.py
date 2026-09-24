#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
我的游戏生涯 — 服务端

一个单端口 HTTP 服务，同时承担两件事：
  1) 托管前端静态文件（手机浏览器直接访问）
  2) 充当 Steam 数据代理：OpenID 登录 + 游戏库/成就/商店信息

设计原则：
  · **无状态**。后端不存任何用户数据，所有进度都在云数据库里，
    由数据库的行级安全策略（RLS）按账号隔离。
  · **密钥不出服务端**。Steam API Key 只在本进程内存里使用，
    任何 /api/ 响应都不会包含它。
  · 只依赖 Python 标准库，不需要 pip install。

启动：
    python server/app.py
    （监听 $PORT，默认 3000）
"""

import gzip
import json
import os
import re
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config                      # noqa: E402
import steam_client                # noqa: E402
import steam_local                 # noqa: E402
import steam_openid                # noqa: E402

VERSION = "0.1.0"

# ===== 手动绑定：把用户填的东西解析成 SteamID64 =====
#
# 这一整套存在的理由：OpenID 授权验签必须请求 steamcommunity.com，
# 而该域名在**国内被拦截**（api.steampowered.com 不受影响）。
# 一旦部署出口访问不了它，授权就永远过不去 —— 这时候用户至少
# 还能手动填 ID 把自己救回来。
#
# 下面四种写法都是用户从 Steam 个人资料页能直接抄到的，全部容忍：
#     https://steamcommunity.com/profiles/<SteamID64>
#     https://steamcommunity.com/id/<自定义名>
#     <SteamID64>
#     <自定义名>
# ⚠️ 这里的示例一律写占位符。2026-09-21 之前这里印的是**库主本人的真实 ID**，
#    而 server/ 是要被整目录打包上线的 —— 文档注释里的真实 ID 也是泄露。
_STEAM_PROFILES_RE = re.compile(r"steamcommunity\.com/profiles/(\d{17})")
_STEAM_VANITY_RE = re.compile(r"steamcommunity\.com/id/([^/?#\s]+)")
_STEAMID64_RE = re.compile(r"(?<!\d)(\d{17})(?!\d)")
_VANITY_OK_RE = re.compile(r"^[A-Za-z0-9_.\-]{2,64}$")


def parse_steam_input(raw):
    """返回 (steamid, vanity, error)；error 为空串表示解析成功。"""
    s = (raw or "").strip()
    if not s:
        return None, None, "empty"

    m = _STEAM_PROFILES_RE.search(s)
    if m:
        return m.group(1), None, ""

    m = _STEAM_VANITY_RE.search(s)
    if m:
        return None, urllib.parse.unquote(m.group(1)), ""

    m = _STEAMID64_RE.search(s)
    if m:
        return m.group(1), None, ""

    if _VANITY_OK_RE.match(s):
        return None, s, ""

    return None, None, "unrecognized"

def api_key():
    """
    生效的 Steam Web API Key。优先级：**用户自己填的 > .env**。

    为什么是这个顺序（2026-09-22 加）：
      · `.env` 那份是**开发机 / 自用**留下的（开发机那把 key，随 `pack_deploy.py` 一起走线上）。
        对外发的桌面版**故意不带 `.env`** —— 所以别人的机器上只有"用户自己填的"这一份，
        这里是空的，联网同步会给出「还没填 Key」+ 申请指引，而不是一个 500。
      · 反过来，用户在自己机器上填了 key 却还在用 `.env` 那份，就会莫名其妙地
        消耗别人的配额 —— 这个顺序同时解决了这件事。

    🔴 这个值**永远不许进日志、不许进任何 HTTP 响应**。要告诉前端"能不能联网"，
       只回布尔（见 `desktop_status()` 的 `hasApiKey`）。
    """
    try:
        user = (steam_local.credentials() or {}).get("apiKey") or ""
    except Exception:
        user = ""
    return user or config.STEAM_API_KEY


def api_key_source():
    """key 是哪来的：`user`（用户自己填的）/ `env`（.env）/ `none`。给界面显示用，不含 key 本身。"""
    try:
        if (steam_local.credentials() or {}).get("apiKey"):
            return "user"
    except Exception:
        pass
    return "env" if config.STEAM_API_KEY else "none"


MIME_FIX = {
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
}

# 商店信息的内存缓存：appid -> 详情 dict（进程存活期间有效）。
# 云数据库里还有一份持久化的全站共享缓存，这里只是第一层挡板。
_store_cache = {}
_store_lock = threading.Lock()

# 游戏库的内存缓存：steamid -> (写入时间, 响应 payload)。
#
# 为什么要缓存：拉库是整个同步里唯一「响应体上百 KB」的请求，跨境链路上偶发断流
# （实测同一时段里，同一个请求既出现过 47 秒彻底失败，也出现过 6.7 秒成功）。
# 用户遇到失败后几乎一定会马上再点一次「同步」—— 有这层缓存，第二次直接命中，
# 不用再赌一次链路。它同时还充当上游失败时的兜底（见 _api_library）。
_lib_cache = {}
_lib_lock = threading.Lock()
LIB_CACHE_TTL = 300        # 秒。正常结果：库内容几分钟内不可能有明显变化
# 降级结果（Steam 没给名称/图标）只缓存很短的时间。
# 否则链路抽风那一下的降级结果会把「没有名字的库」钉住 5 分钟，
# 而用户随便再点一次同步本来就能拿到完整数据。
LIB_CACHE_TTL_LITE = 45
LIB_CACHE_MAX = 200        # 最多缓存多少个账号，防止进程内存无限增长

# `/api/steam/library` 整个处理过程允许花掉的总秒数（外层反代约 50 秒断连，留余量）。
#
# 为什么需要它：库本身有两趟预算（见 steam_client._LIB_BUDGET_MAIN/LITE），
# 但后面还跟着一个「取昵称头像」的装饰性请求。这个字段快慢都无所谓
# （前端有 profile.persona 兜底），却曾把总耗时从十几秒顶到 55.9 秒 ——
# 库数据明明已经拿到了，却在最后一刻被反代掐断，等于白干。
# 所以用「总预算 - 已用时间」算出还能给装饰字段多少，给不够就干脆跳过。
LIB_TOTAL_BUDGET = 42
# 装饰字段最多分到多少秒。再长也不给了 —— 它不值得冒整批被掐的风险。
LIB_PLAYER_BUDGET_MAX = 6

# 「解析 Steam ID」（/api/steam/resolve）与「取玩家资料」（/api/steam/player）
# 里的单次预算。这两个端点**本来就以拿昵称为主**，所以比游戏库那边宽，
# 但同样必须封顶 —— 它们的重试是「再来一遍」，不封顶的话最坏 2×41=82 秒。
# 实测这两个接口健康时 1.0~3.1 秒返回，10 秒（≈2 次尝试 × 4.4 秒）足够宽松。
RESOLVE_BUDGET = 10

# `/api/steam/wishlist` 的出网预算（秒）。
# 愿望单响应约 16 KB（300 款），健康时实测 1.2 秒返回；给 15 秒
# 能容纳「2 次尝试 × 4.4 秒」，链路抽风时还有一次重试机会。
# 它比游戏库小一个数量级，不会把整个同步拖过反代的断连线。
WISH_BUDGET = 15

# 商店接口一次最多受理多少个 appid（对外接口的上限，与 Steam 无关）。
# ⚠️ 注意这是「我们这边一次处理几款」，**不是**「一次向 Steam 问几款」——
# Steam 的商店接口一款一次，拼 appids=1,2,3 会被它 400 拒绝（实测）。
# 所以每款的出站节流才是真正的耗时来源，见 config.STORE_MIN_INTERVAL。
STORE_MAX_IDS = 30

# 两个「逐款问 Steam」的接口各自的软截止时间（秒）。
#
# 为什么必须有：这类接口是内循环逐款出网的，链路抽风时**单款**就可能耗到
# 十几秒。若一批 20 款里有几款卡住，整个请求会拖到几分钟 —— 而外层
# 反向代理约 50 秒就断连，结果是用户等半天拿到一个 504，
# **而且前面已经成功的那些款也一起白干**（响应根本没发出去）。
#
# 有截止时间就变成：到点就停，把剩下的如实报成「这次没拿到」，
# 前端下次同步再来。宁可一批只补一半，也不要整批作废。
STORE_DEADLINE = 34
# 成就这一条 2026-09-20 从 30 改成 34，且含义变了：它不再是「逐款串行的软截止」，
# 而是**并发分波**的收手线（见 steam_client.get_player_achievements_many）。
# 耗时上界可以证明：每波开工前检查 `距截止是否还够 4 秒`，单波最坏 = 该波预算
# → 整批 ≤ deadline + 0（最后一波最多花掉剩下的 4 秒）。34s + 响应开销 < 50s 断连线。
ACH_DEADLINE = 34

# 上面两个截止时间只管「上一款做完，下一款还开不开工」——**并不限制正在跑的那一款**。
# 所以光有截止还不够：单款最坏能拖（商店 8×2=16 秒 / 成就 15 秒），
# 最后一款刚好卡在截止线上开工时，总量就变成「34 + 16 = 50 秒」，
# 又顶回反向代理的断连线上了。
#
# 修法有两半，缺一不可：
#   ① 每款的出网预算 = min(单款上限, 距离截止还剩多少) —— 见下面两个循环；
#   ② 剩余时间连一次尝试都塞不下（< MIN_ITEM_SLACK）时直接不开工，
#      如实报「没拿到」，把时间留给响应本身。
# ⚠️ 必须大于 _fetch_json 里的 timeout 下限 4 秒，否则预算传下去会被它抬高。
MIN_ITEM_SLACK = 5
ACH_ITEM_BUDGET = 10     # 成就健康时云端约 1.9 秒/款（并发后单款仍是这个量级）
STORE_ITEM_BUDGET = 8    # 商店健康时约 0.6 秒/款

# 成就接口对外一次最多受理多少个 appid。
# ⚠️ 这**不是**向 Steam 限流 —— Steam 那边不限制款数（一款一次而已）。
# 它只是「一次 HTTP 往返愿意背多少活」：60 款并发 12 健康时约 10 秒，
# 而成就 deadline 是 34 秒，所以 120 还有一倍余量（健康时）。
# 前端的 ACH_BATCH=60 就是照它留的余量选的。
ACH_MAX_IDS = 120


def log(*parts):
    print("[gv] " + " ".join(str(p) for p in parts), flush=True)


# ============================================================
# 静态文件
# ============================================================
def _is_allowed_static(rel_path):
    """只放行白名单内的前端文件，server/ 与 data/ 一律不可下载。"""
    if not rel_path or rel_path.endswith("/"):
        return False
    if rel_path in config.STATIC_DENY:
        return False
    if rel_path in config.STATIC_FILES:
        return True
    head = rel_path.split("/", 1)[0]
    return head in config.STATIC_DIRS and len(rel_path.split("/")) >= 2


def _safe_join(root, rel_path):
    """把相对路径拼到根目录下，并挡住 ../ 穿越。"""
    rel_path = urllib.parse.unquote(rel_path)
    rel_path = rel_path.replace("\\", "/").lstrip("/")
    parts = []
    for seg in rel_path.split("/"):
        if seg in ("", ".", ".."):
            return None
        parts.append(seg)
    if not parts:
        return None
    abs_path = os.path.abspath(os.path.join(root, *parts))
    root_abs = os.path.abspath(root)
    if not abs_path.startswith(root_abs + os.sep):
        return None
    return abs_path


# ============================================================
# 请求处理
# ============================================================
class Handler(BaseHTTPRequestHandler):
    server_version = "GameVault/" + VERSION
    protocol_version = "HTTP/1.1"

    # ---------- 基础工具 ----------
    def log_message(self, fmt, *args):
        # 默认实现会往 stderr 打一堆噪音，收敛成一行有用的
        log("%s %s" % (self.command, self.path.split("?")[0]))

    def _base_url(self):
        """本服务的公网基地址：优先配置，否则按请求的 Host 推断。"""
        if config.PUBLIC_BASE:
            return config.PUBLIC_BASE
        host = self.headers.get("Host", "localhost:%d" % config.PORT)
        proto = self.headers.get("X-Forwarded-Proto", "http")
        return "%s://%s" % (proto, host)

    def _send(self, code, body, ctype="text/html; charset=utf-8", extra=None,
              cache=None):
        if isinstance(body, str):
            body = body.encode("utf-8")

        # 响应体压缩：游戏库那份 JSON 有上百 KB，在手机网络下很慢。
        # 门槛设 1KB —— 太小的内容压完反而更大。
        # 注意只对“客户端主动声明支持 gzip”的请求压，其它（curl 默认、urllib 默认）
        # 保持明文，避免把不认识 gzip 的调用方搞坏。
        gz = None
        if len(body) >= 1024:
            accept = self.headers.get("Accept-Encoding", "") or ""
            if "gzip" in accept.lower():
                try:
                    body = gzip.compress(body, 6)
                    gz = "gzip"
                except Exception:
                    gz = None

        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if gz:
            self.send_header("Content-Encoding", gz)
            self.send_header("Vary", "Accept-Encoding")
        # 默认不缓存；本机封面这类要反复取的静态图片可以传 cache 覆盖。
        self.send_header("Cache-Control", cache or "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code=200, extra=None):
        self._send(code, json.dumps(obj, ensure_ascii=False),
                   "application/json; charset=utf-8", extra)

    def _redirect(self, url, extra=None):
        self.send_response(302)
        self.send_header("Location", url)
        self.send_header("Content-Length", "0")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()

    def _cookies(self):
        out = {}
        raw = self.headers.get("Cookie", "")
        for piece in raw.split(";"):
            if "=" in piece:
                k, v = piece.split("=", 1)
                out[k.strip()] = v.strip()
        return out

    def _query(self):
        qs = urllib.parse.urlparse(self.path).query
        return urllib.parse.parse_qsl(qs, keep_blank_values=True)

    def _q1(self, name, default=""):
        for k, v in self._query():
            if k == name:
                return v
        return default

    def _read_body(self, limit=64 * 1024):
        """读请求体。超过上限直接当空 —— 这几个接口的请求体只有几十字节，
        没有理由为它开一个可以被塞爆的读循环。"""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            n = 0
        if n <= 0 or n > limit:
            return b""
        try:
            return self.rfile.read(n)
        except Exception:
            return b""

    def _desktop_guard(self):
        """
        桌面版的**回环守卫**（只在 `GV_DESKTOP=1` 时生效；线上完全不走这段）。

        🔴 防的是 DNS rebinding。桌面版服务**没有任何鉴权** —— 它默认「能连上本机的
           就是本机用户」。但浏览器不是这么回事：恶意网页可以把自己的域名解析到
           127.0.0.1，然后 `fetch('http://127.0.0.1:8765/api/local/library')`；
           随机端口能挡一阵，但本机端口范围有限、扫一遍成本很低。
           真挡住它的是**校验 `Host`**：桌面版只会被本机回环访问到，
           Host 不是 127.0.0.1 / localhost / ::1 的，一律拒。
           （请求发得出去、但 Host 会是那个恶意域名 —— 于是这里就拦住了。）

        POST 再加一道 `Origin` 检查：跨站来源直接拒。
        """
        if not config.DESKTOP_MODE:
            return True

        host = (self.headers.get("Host") or "").strip().lower()
        name = (host.rsplit(":", 1)[0] if ":" in host else host).strip("[]")
        if name not in ("127.0.0.1", "localhost", "::1"):
            log("拒绝非回环 Host：%r" % host)
            return False

        if self.command not in ("GET", "HEAD"):
            origin = (self.headers.get("Origin") or "").strip()
            if origin:
                try:
                    oh = urllib.parse.urlparse(origin).hostname or ""
                except Exception:
                    oh = ""
                if oh not in ("127.0.0.1", "localhost", "::1"):
                    log("拒绝跨站 Origin：%r" % origin)
                    return False
        return True

    def _guard_steam_key(self):
        """没有可用的 key 就别往下走。

        桌面版多给一条可执行的指引：key 是**用户自己填**的（存本机 desktop.json），
        不像线上版那样由部署方配 .env —— 所以不能说"服务端未配置"，那话对用户没有意义。
        """
        if not api_key():
            if config.DESKTOP_MODE:
                self._json({
                    "error": "no_key",
                    "message": "还没有填 Steam Web API Key，读不到联网数据。",
                    "howToFix": [
                        "去 Steam 官方申请一个（免费）：https://steamcommunity.com/dev/apikey",
                        "打开顶栏「设置」→「Steam 账号（联网同步）」把 Key 粘进去",
                        "点「验证并保存」",
                    ],
                }, 200)
            else:
                self._json({"error": "服务端未配置 STEAM_API_KEY"}, 500)
            return False
        return True

    # ---------- 路由 ----------
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if not self._desktop_guard():
            return self._json({"error": "non_loopback_host",
                               "hint": "桌面版只接受来自本机回环地址的请求"}, 403)

        if path == "/api/health":
            return self._json({
                "ok": True,
                "version": VERSION,
                "hasKey": bool(api_key()),
                "keySource": api_key_source(),
                "time": int(time.time()),
            })

        if path == "/api/diag":
            return self._api_diag()

        if path == "/auth/steam/start":
            return self._steam_start()

        if path == "/auth/steam/callback":
            return self._steam_callback()

        if path == "/api/steam/resolve":
            return self._api_resolve()

        if path == "/api/steam/player":
            return self._api_player()

        if path == "/api/steam/library":
            return self._api_library()

        if path == "/api/steam/wishlist":
            return self._api_wishlist()

        if path == "/api/steam/ping":
            return self._api_steam_ping()

        if path == "/api/steam/achievements":
            return self._api_achievements()

        if path == "/api/steam/store":
            return self._api_store()

        if config.DESKTOP_MODE:
            # 本机模式（Windows 桌面版）。线上 GV_DESKTOP 未设 → 这里永不进入，
            # 下面这些路径落到 _static 得到 404。
            if path == "/api/local/status":
                return self._api_local_status()
            if path == "/api/local/library":
                return self._api_local_library()
            # 家庭组成员名单（**只回名单**，成员各自的库仍走 /api/steam/library）。
            # ⚠️ 这条路由曾经漏注册过：方法 `_api_local_family` 写好了、却没人派发到它，
            #    表现是前端拿到 404 → getJSON 抛错 → 面板显示"本机服务没有响应"，
            #    看起来像服务没起。`_t_srv_local.py` 的 B6 段专门盯这一条。
            if path == "/api/local/family":
                return self._api_local_family()
            if path == "/api/local/cover":
                return self._api_local_cover()
            # 用户填的目录先探一下再说（不落盘）；扫盘只在用户点按钮时走
            if path == "/api/local/probe":
                return self._api_local_probe()
            if path == "/api/local/scan":
                return self._api_local_scan()

        return self._static(path)

    def do_POST(self):
        """
        桌面版目前**只有**一个 POST：保存用户指定的 Steam 目录。

        ⚠️ 这是本服务端唯一的写接口。守卫 `_desktop_guard()` 对它尤其重要 ——
           其余接口最坏是被读走数据，这个可以被跨站写进一个目录去。
        """
        path = urllib.parse.urlparse(self.path).path
        if not self._desktop_guard():
            return self._json({"error": "non_loopback_host",
                               "hint": "桌面版只接受来自本机回环地址的请求"}, 403)
        if config.DESKTOP_MODE and path == "/api/local/settings":
            return self._api_local_settings()
        return self._json({"error": "not_found"}, 404)

    def do_HEAD(self):
        self.do_GET()

    # ---------- 本机模式（Windows 桌面版）----------
    # 🔴 只有 config.DESKTOP_MODE 为真时 do_GET/do_POST 才会路由到这里。
    #    这些接口读的是**本机 Steam 的个人数据**（安装路径 / 账号 / 库 / 时长 / 封面），
    #    并且 `/api/local/settings` 还会**写**一个用户目录。绝不能出现在对外服务上 ——
    #    改判定条件前先读 DESIGN.md 的「Steam 本地文件」一节。
    def _api_local_status(self):
        """
        桌面版状态：是不是桌面版 + 现在用哪个 Steam 目录 + 它是哪来的。

        `desktop: true` 兼作前端的**桌面模式探测标志**（js/local-src.js 靠它判模式），
        别改名、别删。
        """
        st = steam_local.desktop_status()
        return self._json(dict({
            "desktop": True,
            "available": bool(st.get("steamDir")),
            "steamDir": st.get("steamDir"),
            # 「能不能联网同步」由前端判断，所以这里把两个**事实**都给出去：
            # 用户自己填了 key 没有、以及 .env 里有没有一份（开发机/自用那套）。
            # ⚠️ 只给布尔 —— key 本身永不出现在响应里，连末四位都不给。
            "hasEnvKey": bool(config.STEAM_API_KEY),
        }, **st))

    def _api_local_library(self):
        return self._json(steam_local.read_library(steam_id=self._q1("steamid") or None))

    def _api_local_family(self):
        """
        Steam 家庭组的成员名单。

        返回 `{ok:true, group:{groupid,name,role}, members:[{accountid,steamId,role,isMe}]}`；
        这个账号没加入家庭组时 `{ok:false, reason:"no_family"}`（**200**，不是错误 ——
        没有家庭组是完全正常的状态）。

        🔴 **这里只回名单，不回任何人的库**，是刻意的：
           成员各自的库由前端逐个去 `/api/steam/library?steamid=<成员>` 拿 ——
           那条接口本来就能查任意 steamid，而且**带着完整的失败归因**
           （资料不公开 / 链路不通 / 没 key，各带可执行的 `howToFix`）。
           在这儿再实现一遍取库，等于把归因逻辑复制一份，迟早两边不一致。
        """
        g = steam_local.read_family_group()
        if not g:
            return self._json({
                "ok": False, "reason": "no_family",
                "hint": "这个账号没有加入 Steam 家庭组，或本机文件里没有家庭组记录",
            })
        return self._json({
            "ok": True,
            "group": {"groupid": g["groupid"], "name": g["name"], "role": g["role"]},
            "members": g["members"],
        })

    def _api_local_cover(self):
        appid = self._q1("appid")
        if not appid.isdigit():
            return self._json({"error": "appid 必须是数字"}, 400)
        kind = self._q1("k") or None
        p = steam_local.cover_path(steam_local.resolve_steam_dir(), int(appid), kind)
        if not p:
            return self._json({"error": "这款没有本地封面"}, 404)
        try:
            with open(p, "rb") as f:
                blob = f.read()
        except OSError:
            return self._json({"error": "封面读取失败"}, 500)
        ctype = "image/png" if p.lower().endswith(".png") else "image/jpeg"
        return self._send(200, blob, ctype, cache="max-age=86400")

    def _api_local_probe(self):
        """探一个目录像不像 Steam 安装目录。**只读不写** —— 用户还在输入框里打字时就调它。"""
        return self._json(steam_local.looks_like_steam(self._q1("path"), with_accounts=True))

    def _api_local_scan(self):
        """
        扫盘找 Steam。**只在用户点「扫描磁盘」时被调用**（见 steam_local.scan_for_steam）。
        它是全盘 IO，绝不能进任何自动流程。
        """
        return self._json(steam_local.scan_for_steam())

    def _api_local_settings(self):
        """
        桌面版设置：Steam 安装目录 / SteamID / API Key。校验通过才落盘。

        🔴 **按"字段是否出现"处理，不是按"字段有没有值"** ——
           这一条以前踩过：旧实现写死 `body.get("steamDir", "")`，
           于是任何一个**不含 steamDir** 的请求都等于"把目录清空"。
           现在多带两个字段，若不改就变成「存一下 API Key，顺手把 Steam 目录删了」。
           所以：键不出现 = 不动；键出现且为空串 = 清掉。
        """
        try:
            body = json.loads(self._read_body().decode("utf-8") or "{}")
        except Exception:
            return self._json({"error": "bad_json",
                               "hint": "请求体应当是一个 JSON 对象"}, 400)
        if not isinstance(body, dict):
            return self._json({"error": "bad_json",
                               "hint": "请求体应当是一个 JSON 对象"}, 400)

        touched = [k for k in ("steamDir", "steamId", "steamApiKey") if k in body]
        if not touched:
            return self._json({"error": "no_fields",
                               "hint": "请求体里至少要有一个可写字段",
                               "fields": ["steamDir", "steamId", "steamApiKey"]}, 400)

        res = {"ok": True, "changed": []}
        try:
            if "steamDir" in body:
                r = steam_local.set_steam_dir(body.get("steamDir"))
                if not r.get("ok"):
                    r["status"] = steam_local.desktop_status()
                    return self._json(r, 400)
                # 把 `cleared` / `steamDir` / `probe` 这些一并回给前端
                # （`cleared` 是既有契约：测试与前端都读它判断"是否已清空回到自动检测"）
                res.update({k: v for k, v in r.items() if k != "status"})
                res["changed"].append("steamDir")

            if "steamId" in body or "steamApiKey" in body:
                r = steam_local.set_credentials(
                    steam_id=body.get("steamId") if "steamId" in body else None,
                    api_key=body.get("steamApiKey") if "steamApiKey" in body else None)
                if not r.get("ok"):
                    r["status"] = steam_local.desktop_status()
                    return self._json(r, 400)
                res["changed"].extend(r.get("changed") or [])
        except Exception as e:                      # 兜底：绝不把栈信息抛给前端
            log("保存设置失败：%r" % (e,))
            return self._json({"error": "save_failed",
                               "message": "保存设置时出错：%s" % e}, 500)

        res["status"] = steam_local.desktop_status()
        return self._json(res, 200)

    # ---------- 诊断 ----------
    def _api_diag(self):
        """
        服务端出网自检 —— 排查「Steam 授权过不去 / 同步失败」的第一站。

        三个域名分别对应三件事，缺一不可：
          · steamcommunity.com     OpenID 授权验签（**授权能不能过全看它**）
          · api.steampowered.com   游戏库 / 成就
          · store.steampowered.com 名称 / 封面 / 发售年

        只回报域名、可达性和耗时，不含任何密钥或用户数据。
        只要收到 HTTP 响应就算通（403/404 也算）—— 排查这类问题时，
        「连不上」和「连上了但被拒」是完全不同的两件事。
        """
        targets = [
            ("openid", "Steam 授权验签", config.STEAM_OPENID_ENDPOINT),
            ("api", "游戏库 / 成就",
             config.API + "/ISteamWebAPIUtil/GetServerInfo/v1/"),
            ("store", "商店信息",
             config.STORE_API + "?appids=570&l=schinese"),
        ]
        results = {}

        def work(key, url):
            results[key] = steam_client.probe(url, timeout=12)

        threads = []
        for key, _label, url in targets:
            t = threading.Thread(target=work, args=(key, url))
            t.daemon = True
            t.start()
            threads.append(t)
        for t in threads:
            t.join(25)

        checks = []
        for key, label, url in targets:
            r = results.get(key) or {"ok": False, "status": 0, "ms": -1,
                                     "error": "timeout (无响应)"}
            checks.append({
                "key": key,
                "what": label,
                "host": urllib.parse.urlparse(url).netloc,
                "ok": bool(r.get("ok")),
                "status": r.get("status"),
                "ms": r.get("ms"),
                "error": r.get("error") or "",
            })

        # 附带自检：商店接口的四种用法并排探一遍。
        # 这里留着一份「实测证据」，以后谁想再动商店接口的用法，先看这行数据，
        # 别再把下面两个已经证伪的想法重走一遍：
        #   multi_*       多款逗号拼接 -> **实测被 Steam 400 拒绝**（单款 200）。
        #                 所以「一次多问几款」不成立，只能一款一次（见 _api_store）。
        #   *_basic       filters=basic -> 确实能把响应体压小，但它砍掉的正是
        #                 我们要的字段（570 返回 release_date:null / genres:[]），
        #                 所以生产上 filters 留空（config.STORE_FILTERS=""）。
        # 现在 single_plain 与 single_basic 的 URL 完全相同（filters 为空）——
        # 保留两行是为了链路抽风时能看出「同一形态两次结果不一样」。
        variants = [
            ("single_plain", steam_client.store_url("570")),
            ("single_basic", steam_client.store_url("570", filters=config.STORE_FILTERS)),
            ("multi_plain", steam_client.store_url("570,440")),
            ("multi_basic", steam_client.store_url("570,440", filters=config.STORE_FILTERS)),
        ]
        vres = {}

        def work_variant(key, url):
            # 这一节是诊断，不节流 —— 只发 4 个请求，快比礼貌重要
            vres[key] = steam_client.probe_json(url, timeout=15)

        vthreads = []
        for key, url in variants:
            t = threading.Thread(target=work_variant, args=(key, url))
            t.daemon = True
            t.start()
            vthreads.append(t)
        for t in vthreads:
            t.join(20)

        store_probe = {}
        for key, _url in variants:
            r = vres.get(key) or {"ok": False, "status": 0, "bytes": 0,
                                  "parsed": False, "error": "timeout", "ms": -1}
            store_probe[key] = {
                "ok": bool(r.get("ok")),
                "status": r.get("status"),
                "bytes": r.get("bytes"),
                "parsed": bool(r.get("parsed")),
                "ms": r.get("ms"),
                "error": (r.get("error") or "")[:160],
            }
        # 判定标准：单款能通就算商店链路本身没问题（多款被拒是 Steam 的既定行为，
        # 不算故障，否则每次 diag 都是红的，真出问题时反而看不出异常）
        store_ok = bool(store_probe.get("single_basic", {}).get("parsed")
                        or store_probe.get("single_plain", {}).get("parsed"))

        bad = [c["key"] for c in checks if not c["ok"]]
        if not store_ok and "store" not in bad:
            bad.append("store")
        return self._json({
            "service": "gamevault",
            "version": VERSION,
            "allReachable": not bad,
            "unreachable": bad,
            "checks": checks,
            "storeProbe": store_probe,
        })

    # ---------- Steam 登录 ----------
    def _steam_start(self):
        base = self._base_url()
        state = steam_openid.new_state()
        return_to = "%s/auth/steam/callback?state=%s" % (base, urllib.parse.quote(state))
        url = steam_openid.build_login_url(return_to, base)
        log("OpenID 跳转 -> Steam (state=%s…)" % state[:6])
        self._redirect(url, extra={
            # state 同时写进 cookie，回调时比对，防跨站伪造。
            # 有效期给足 30 分钟：用户可能要在 Steam 那边输密码 / 走邮箱验证码 /
            # 手机令牌，10 分钟经常不够（超时后回调只会报 state 不匹配，
            # 用户完全看不出是「等太久」导致的）。
            "Set-Cookie": "gv_state=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800"
                          % state,
        })

    def _steam_callback(self):
        base = self._base_url()
        q = self._query()
        want_state = ""
        for k, v in q:
            if k == "state":
                want_state = v
                break
        have_state = self._cookies().get("gv_state", "")

        if not want_state or not have_state or want_state != have_state:
            log("OpenID 回调被拒：state 不匹配")
            return self._redirect(base + "/?steam_error=state")

        res = steam_openid.verify(q)
        if not res.get("ok"):
            reason = res.get("reason") or "verify"
            log("OpenID 回调被拒：%s %s" % (reason, res.get("detail", "")))
            return self._redirect(
                base + "/?steam_error=" + urllib.parse.quote(reason))

        steamid = res["steamid"]
        log("OpenID 验签通过：%s" % steamid)
        # 回到前端，把结果交给前端写入用户自己的记录
        self._redirect(
            base + "/?steam_bound=" + urllib.parse.quote(steamid),
            extra={"Set-Cookie": "gv_state=; Path=/; HttpOnly; Max-Age=0"},
        )

    # ---------- Steam 数据代理 ----------
    def _api_resolve(self):
        """
        把用户填的 Steam ID / 个人资料链接解析成 SteamID64（手动绑定用）。

        全程只走 api.steampowered.com，**不碰 steamcommunity.com** ——
        所以当部署出口访问不了后者（OpenID 验签必须用的域名）时，
        这条路依然能把账号绑上。
        """
        if not self._guard_steam_key():
            return
        raw = (self._q1("q") or "").strip()
        steamid, vanity, err = parse_steam_input(raw)
        if err == "empty":
            return self._json({"error": "empty",
                               "message": "请先填写你的 Steam ID 或个人资料链接"}, 400)
        if err:
            return self._json({"error": "unrecognized",
                               "message": "这看起来不是 Steam ID，也不是个人资料链接"}, 400)

        if vanity:
            sid, rerr = steam_client.resolve_vanity(api_key(), vanity,
                                                   budget=RESOLVE_BUDGET)
            if rerr == "network":
                return self._json({"error": "steam_unreachable",
                                   "message": "服务器暂时连不上 Steam，请稍后重试"}, 502)
            if not sid:
                return self._json({"error": "vanity_not_found",
                                   "message": "没找到这个自定义 ID，检查一下拼写"}, 404)
            steamid = sid

        # 昵称/头像是这个端点的主产物，所以预算给得比游戏库那边宽 ——
        # 但仍然要封顶：默认的 timeout=20 × (1 次重试) 最坏 41 秒，
        # 两次尝试就是 82 秒，早就被反代掐断了。
        info = steam_client.get_player_summary(
            api_key(), steamid, budget=RESOLVE_BUDGET)
        if not info:
            # 同上：区分「偶发抽风」和「查无此人」，别丢一个误导性的 404
            time.sleep(0.6)
            info = steam_client.get_player_summary(
                api_key(), steamid, budget=RESOLVE_BUDGET)
        if not info:
            return self._json({"error": "player_unavailable",
                               "message": "拿不到这个账号的资料，请稍后重试"}, 502)

        return self._json({"steamid": steamid, "player": info})

    def _api_player(self):
        if not self._guard_steam_key():
            return
        steamid = self._q1("steamid")
        if not steamid.isdigit():
            return self._json({"error": "steamid 不合法"}, 400)
        info = steam_client.get_player_summary(
            api_key(), steamid, budget=RESOLVE_BUDGET)
        if not info:
            # GetPlayerSummaries 偶发抽风（实测线上大约几十次里会碰到一次），
            # 而 get_player_summary 把「偶发失败」和「查无此人」都归成 None。
            # 所以这里再补一次尝试：仍失败时明确报 502（暂时不可用），
            # 而不是丢一个会让人以为账号不存在的 404。
            time.sleep(0.6)
            info = steam_client.get_player_summary(
                api_key(), steamid, budget=RESOLVE_BUDGET)
        if not info:
            return self._json({"error": "Steam 接口暂时不可用，请稍后重试"}, 502)
        return self._json({"player": info})

    def _api_library(self):
        if not self._guard_steam_key():
            return
        t_start = time.time()
        steamid = self._q1("steamid")
        if not steamid.isdigit():
            return self._json({"error": "steamid 不合法"}, 400)

        # 命中缓存直接返回：既省一次跨境大请求，也让用户「失败后再点一次」能立刻成功。
        # 条目里带着自己的 TTL —— 正常结果 5 分钟，降级结果只有 45 秒（见常量注释）。
        with _lib_lock:
            hit = _lib_cache.get(steamid)
        if hit and (time.time() - hit[0]) < hit[2]:
            cached = dict(hit[1])
            cached["cached"] = True
            return self._json(cached)

        games, is_private, names_ok = steam_client.get_owned_games(
            api_key(), steamid)

        if games is None:
            # 上游彻底拉不动了。手里有旧数据就顶上去 ——
            # 让用户看到「上次的结果 + 一句解释」，比甩一个 502 有用得多：
            # 502 会让他反复重试，而他其实什么都没做错。
            if hit:
                stale = dict(hit[1])
                stale["cached"] = True
                stale["stale"] = True
                stale["message"] = "这次没连上 Steam，先显示上一次同步的结果。"
                return self._json(stale)
            return self._json({
                "error": "steam_unreachable",
                "message": "连不上 Steam（跨境链路波动），稍等几秒再点一次「同步」通常就好了。",
            }, 502)

        if is_private:
            # 这是最常见的失败原因，给出可执行的指引而不是一句报错
            return self._json({
                "error": "profile_private",
                "message": "Steam 的「游戏详情」没有公开，读不到游戏库。",
                "howToFix": [
                    "打开 Steam 网页版并登录",
                    "右上角昵称 → 查看我的个人资料 → 编辑个人资料",
                    "左侧选「隐私设置」",
                    "把「游戏详情」改成「公开」",
                    "等 1-2 分钟让 Steam 刷新缓存，再回来重试",
                ],
                "steamPrivacyUrl": "https://steamcommunity.com/my/edit/settings",
            }, 200)

        # 昵称/头像纯装饰：前端会用已存的 profile.persona 兜底，拿不到完全不影响
        # 同步。所以在这里卡死预算 —— 库数据已经到手了，绝不能为了它把整批
        # 拖过反代的断连线（实测踩过：库 15 秒就回来了，总耗时却是 55.9 秒）。
        left = LIB_TOTAL_BUDGET - (time.time() - t_start)
        player = None
        if left > 2:
            player = steam_client.get_player_summary(
                api_key(), steamid,
                budget=min(LIB_PLAYER_BUDGET_MAX, left))

        out = []
        for g in games:
            appid = g.get("appid")
            if not appid:
                continue
            icon = ""
            if g.get("img_icon_url"):
                icon = ("https://media.steampowered.com/steamcommunity/public/images/apps/%s/%s.jpg"
                        % (appid, g["img_icon_url"]))
            out.append({
                "appid": int(appid),
                # 降级路径下 Steam 没给名称，这里就必须留空。
                # ⚠️ 绝不能编一个「App 123」顶上：前端会把它当成真名字写进公共缓存，
                #    把别人（或自己）早先存好的真名字覆盖掉 —— 那款游戏从此就叫 App 123 了。
                "title": g.get("name") or "",
                "icon": icon,
                "totalMinutes": g.get("playtime_forever") or 0,
                "recentMinutes": g.get("playtime_2weeks") or 0,
                "lastPlayedTs": g.get("rtime_last_played") or 0,
            })
        log("游戏库 %s -> %d 款（%s）"
            % (steamid, len(out), "含名称" if names_ok else "降级：无名称"))
        payload = {
            "steamid": steamid,
            "player": player,
            "count": len(out),
            # namesOk=false 告诉前端：这批数据缺名称/图标，不要拿空值去覆盖公共缓存
            "namesOk": names_ok,
            "games": out,
        }
        # 只缓存成功的结果。缓存放的是整个 payload，所以 _lib_cache 里的条目
        # 一定不带 cached / stale 标记（那些是返回时临时加的）。
        with _lib_lock:
            if len(_lib_cache) >= LIB_CACHE_MAX:
                oldest = min(_lib_cache.items(), key=lambda kv: kv[1][0])[0]
                _lib_cache.pop(oldest, None)
            _lib_cache[steamid] = (time.time(), payload,
                                   LIB_CACHE_TTL if names_ok else LIB_CACHE_TTL_LITE)
        return self._json(payload)

    def _api_wishlist(self):
        """取玩家的 Steam 愿望单（给「导入待游玩」用）。

        走 `IWishlistService/GetWishlist/v1`（官方 Web API，未公开文档；
        老的那两个 `store.steampowered.com/wishlist/.../wishlistdata/`
        2024-11 已废弃 —— 详见 steam_client.get_wishlist 的注释）。

        三种结果，**前端必须分开处理**：

          {"steamid":…, "state":"ok", "count":N, "items":[…]}
              拿到了。items = [{appid, priority, addedTs}]
          {"steamid":…, "state":"unavailable", "message":…}
              接口明确回答「没有」—— 但这是**空**和**未公开**两种情况共用的答案，
              Steam 返回的字节完全一样，分不开。文案要把两种可能都写上。
          502 {"error":"steam_unreachable", …}
              这次没连上（链路波动）。**前端绝不能把它当成「愿望单空了」**
              —— 那会触发删除，一次抖动清掉几百款记录。

        ⚠️ 这个接口**故意不做服务端缓存**（和 /api/steam/library 不同）：
        前端要拿它的结果做「哪些已从愿望单移除 -> 删掉对应记录」的差集判断，
        一份陈旧的结果会把「这 5 分钟里新加的款」误判成「被移除了」。
        一次请求只有约 1.2 秒、约 16 KB，不值得为它引入这个风险。
        """
        if not self._guard_steam_key():
            return
        steamid = self._q1("steamid")
        if not steamid.isdigit():
            return self._json({"error": "steamid 不合法"}, 400)

        items, state = steam_client.get_wishlist(
            api_key(), steamid, budget=WISH_BUDGET)

        if state == "error":
            return self._json({
                "error": "steam_unreachable",
                "message": "连不上 Steam（跨境链路波动），稍等几秒再点一次「同步」通常就好了。",
            }, 502)

        if state == "unavailable":
            return self._json({
                "steamid": steamid,
                "state": "unavailable",
                "count": 0,
                "items": [],
                "message": "没读到愿望单。可能是愿望单是空的，"
                           "也可能是隐私设置没公开（Steam 对这两种情况的回答完全一样）。",
                "howToFix": [
                    "打开 Steam 网页版并登录",
                    "右上角昵称 → 查看我的个人资料 → 编辑个人资料",
                    "左侧选「隐私设置」",
                    "把「愿望单」改成「公开」",
                    "等 1-2 分钟让 Steam 刷新缓存，再回来重试",
                ],
                "steamPrivacyUrl": "https://steamcommunity.com/my/edit/settings",
            })

        log("愿望单 %s -> %d 款" % (steamid, len(items)))
        return self._json({
            "steamid": steamid,
            "state": "ok",
            "count": len(items),
            "items": items,
        })

    def _api_steam_ping(self):
        """轻量出网预检：只探一次 `api.steampowered.com`，回答「此刻能不能连上 Steam」。

        为什么要有它（2026-09-20 加）：链路整体断掉时，成就接口每批要等满 34 秒
        预算才肯返回，前端一轮 7 批就是约 4 分钟白等（线上实测两条消息相隔 244 秒，
        正是 7×34）。花几秒先探一次，就能在**开始扫描之前**判定「现在扫不了」，
        把 4 分钟缩短成几秒，而且给出的原因是准确的。

        与 /api/diag 的分工：diag 探 3 个域名、最长 25 秒，是给人排查用的；
        ping 只探「游戏库/成就」所在的那一个域名、最长 6 秒，是给程序当开关用的。

        返回 {"ok": bool, "ms": int, "error": str}；不看响应内容，拿到任何 HTTP
        响应就算通（403/404 也算）—— 这里要回答的是「链路通不通」，不是「有没有权限」。
        """
        if not self._guard_steam_key():
            return
        r = steam_client.probe(
            config.API + "/ISteamWebAPIUtil/GetServerInfo/v1/", timeout=6)
        return self._json({"ok": bool(r.get("ok")),
                           "ms": r.get("ms"),
                           "error": (r.get("error") or "")[:120]})

    def _api_achievements(self):
        """取玩家在若干游戏里的成就进度。

        - 单个：?steamid=X&appid=123           -> {"achievements": {...}}
        - 批量：?steamid=X&appids=1,2,3        -> {"items": {"1": {...}}}

        批量走**并发**（`steam_client.get_player_achievements_many`，在飞 12 个）。
        ⚠️ 别改回"逐个串行 + 全局节流"：那正是"每轮只扫 60 款、全库要跑 4~6 次"的
        唯一原因。Steam 侧实测并发 32 跑完全库只要 15.0 秒、零 429 —— 慢的是我们自己，
        不是 Steam 限流。完整实测见 .workbuddy/memory/DESIGN.md「Steam 限流实测」。
        一次最多 `ACH_MAX_IDS` 个（前端一批 60，留了一倍余量）。
        """
        if not self._guard_steam_key():
            return
        steamid = self._q1("steamid")
        if not steamid.isdigit():
            return self._json({"error": "参数不合法"}, 400)

        single = self._q1("appid")
        if single:
            if not single.isdigit():
                return self._json({"error": "参数不合法"}, 400)
            ach = steam_client.get_player_achievements(
                api_key(), steamid, single)
            return self._json({"steamid": steamid, "appid": int(single),
                               "achievements": ach})

        ids = [x for x in self._q1("appids").split(",") if x.strip().isdigit()]
        # 去重保序
        seen, ordered = set(), []
        for x in ids:
            if x not in seen:
                seen.add(x)
                ordered.append(x)
        ordered = ordered[:ACH_MAX_IDS]
        if not ordered:
            return self._json({"error": "appids 为空"}, 400)

        ach_stats = {}   # 由 get_player_achievements_many 填：失败原因分类 + 链路质量
        items = steam_client.get_player_achievements_many(
            api_key(), steamid, ordered,
            workers=config.STEAM_MAX_CONCURRENCY,
            deadline=time.time() + ACH_DEADLINE,
            item_budget=ACH_ITEM_BUDGET,
            stats=ach_stats)
        # 没轮到的款**必须**如实报 None（契约里 None = 「不知道」，前端会照此不写入、
        # 下次同步重试）。并发分波版本只会漏掉"到点还没开工"的那些，不会漏中间款。
        for appid in ordered:
            items.setdefault(appid, None)
        got = sum(1 for a in ordered if items.get(a) is not None)
        log("成就批量查询 %s -> %d 款（拿到 %d，链路 %s）"
            % (steamid, len(ordered), got, ach_stats.get("link")))
        return self._json({
            "steamid": steamid,
            "items": items,
            # ===== 为什么要把失败原因回传（2026-09-20 加）=====
            # 契约里「没拿到」一律是 null，前端只能**猜**原因 —— 结果它把所有 null
            # 都写成「Steam 限流」，而实测 4000+ 次请求一个 429 都没有，失败全在
            # TLS/读取层。用户拿着那句话判断「是不是被限流」，必然误判。
            # 现在把服务端已有的分类结果一起带回去，前端才能：
            #   ① 说清「哪儿出了问题」② 决定「要不要停止剩下的批次」
            #  ③ 决定「下一批开多大」（link=degraded 时收窄，避免尾巴整段截断）
            # 这些字段是**附加信息**，旧前端忽略它们也能正常工作。
            "link": ach_stats.get("link", "ok"),
            "reasons": ach_stats.get("reasons") or {},
            "skipped": ach_stats.get("skipped", 0),
        })

    def _api_store(self):
        """取一批游戏的公共信息（名称/发售日期/封面/类型/开发商）。

        ⚠️ 外层的「一批」只是省往返次数的壳子：Steam 那边**一款一次**
        （把 appid 拼成 appids=1,2,3 会被它 400 拒绝，实测稳定复现）。
        所以这里逐个问，慢的那部分靠两样东西压住：
          · config.STORE_MIN_INTERVAL 把出站节流放短（商店接口限流宽松）
          · 每款的出网预算按「距离 STORE_DEADLINE 还剩多少」给，见下面的循环
        （曾经想用 filters=basic 把响应砍小，实测它会把发售年份/类型一起砍掉，
          已撤掉 —— 见 get_app_details 的注释。）

        返回：
            items   {appid: 详情 dict | null}   null = Steam 明确说查不到（下架/锁区）
            unknown [appid…]                    这次没拿到答案（网络/限流）。
                                                调用方**不要**把它记成「已查过」，
                                                否则那款游戏的封面永远补不回来。
        """
        raw = [x for x in self._q1("appids").split(",") if x.strip().isdigit()]
        # 去重保序
        seen, ids = set(), []
        for x in raw:
            if x not in seen:
                seen.add(x)
                ids.append(x)
        ids = ids[:STORE_MAX_IDS]
        if not ids:
            return self._json({"error": "appids 为空"}, 400)

        out, unknown = {}, []
        deadline = time.time() + STORE_DEADLINE
        for appid in ids:
            with _store_lock:
                if appid in _store_cache:
                    out[appid] = _store_cache[appid]
                    continue
            left = deadline - time.time()
            if left < MIN_ITEM_SLACK:
                # 时间用完了：剩下的如实报成「没拿到」，别硬撑到被代理掐断
                out[appid] = None
                unknown.append(appid)
                continue
            v, answered = steam_client.get_app_details_ex(
                appid, filters=config.STORE_FILTERS,
                budget=min(STORE_ITEM_BUDGET, left))
            if answered:
                # 拿到确定答复 —— 连 None 都是答复（Steam 明说这款查不到）。
                # 缓存下来，之后就不用再问了。
                with _store_lock:
                    _store_cache[appid] = v
                out[appid] = v
            else:
                # 没答复：**不进缓存**，并且如实报给前端，让它别标记「已补」。
                out[appid] = None
                unknown.append(appid)
        return self._json({"items": out, "unknown": unknown})

    # ---------- 静态 ----------
    def _static(self, path):
        if path == "/":
            path = "/index.html"
        if not _is_allowed_static(path.lstrip("/")):
            return self._send(404, "Not Found", "text/plain; charset=utf-8")
        abs_path = _safe_join(config.WEB_DIR, path.lstrip("/"))
        if not abs_path or not os.path.isfile(abs_path):
            return self._send(404, "Not Found", "text/plain; charset=utf-8")
        ext = os.path.splitext(abs_path)[1].lower()
        ctype = MIME_FIX.get(ext, "application/octet-stream")
        try:
            with open(abs_path, "rb") as f:
                body = f.read()
        except Exception as e:
            return self._send(500, "Read failed: %s" % e, "text/plain; charset=utf-8")
        return self._send(200, body, ctype)


def build_server(host="0.0.0.0", port=None):
    """
    建一个 HTTP 服务实例（**只建不启动**）。

    云端 `main()` 和桌面版启动器（`desktop/main.py`）都走这里，避免两处各写一份绑定逻辑。

    · `port=None` → 用 `config.PORT`；**`port=0` → 让系统分配一个空闲端口**
      （桌面版要的就是这个：不跟别的程序抢 3000）。
      真实端口请读返回对象的 `server_address[1]`。
    · `host="127.0.0.1"` 是桌面版必须的 —— 只监听回环，局域网内别的机器连不上。
    """
    server = ThreadingHTTPServer((host, config.PORT if port is None else port), Handler)
    server.daemon_threads = True
    return server


def main():
    server = build_server("0.0.0.0")
    log("=" * 52)
    log("我的游戏生涯 服务端 v%s" % VERSION)
    log("监听 %s:%d" % server.server_address[:2])
    log("Steam API Key：%s" % ({"user": "用户自己填的", "env": ".env 里的", "none": "【缺失】"}
                               [api_key_source()]))
    log("静态目录：%s" % config.WEB_DIR)
    log("本机模式：%s" % ("开（桌面版）" if config.DESKTOP_MODE else "关"))
    log("=" * 52)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("收到中断，退出")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
