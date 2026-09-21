# -*- coding: utf-8 -*-
"""
Steam Web API 客户端 —— 服务端专用。

从原来的 scripts/sync.py 抽出来，去掉本地文件依赖，
改成给 HTTP 服务调用的函数。所有出站请求都带全局间隔控制，
因为 Steam 官方限制约 1 请求/秒，并会被 HTTP 429 拒绝。
"""

import gzip
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from concurrent import futures

from config import (API, STORE_API, STORE_MIN_INTERVAL, STEAM_MAX_CONCURRENCY,
                    STEAM_MIN_INTERVAL, UA)

# 单次尝试的超时下限（秒）。再短就没有意义了 —— 跨境链路健康时一次也要
# 0.3~1.3 秒，1 秒以内的超时等于「必定失败」，只会白烧一次尝试。
# ⚠️ 它是 _fetch_json 预算逻辑的一部分：预算不够容纳「下限 × 尝试次数」时，
#    会优先砍重试次数（见那里的注释），所以调用方传 budget 时必须留出余量。
MIN_ATTEMPT_TIMEOUT = 4

# 两趟扫描时，第一趟最多花掉总时间的这个比例（剩下的留给"失败项重跑"那一趟）。
# 6:4 是这么定的：偶发失败通常只占少数（线上实测一次约 1/3~2/3，且其中一半重问就好），
# 而**没轮到**的款比**问失败**的款更糟（前者说明我们连机会都没给），所以第一趟占大头、
# 但必须给重试留下足够跑一趟的时间。见 get_player_achievements_many 的说明。
_FIRST_PASS_SHARE = 0.6

# Steam 对「这款游戏没有 stats/成就」的原文回答（HTTP 400，body 里是
# {"playerstats":{"error":"Requested app has no stats"}}）。
#
# 单独抽成常量是为了让它显眼：它是**唯一**一条「把失败当确定性答案」的例外，
# 改它等于改「哪些游戏会被永久标记为没有成就」，必须格外小心。
# 匹配用的是子串（大小写不敏感），Steam 前面那句 "Requested app has" 会不会变
# 不确定，所以只卡最关键、最不可能变的 "no stats"。
_NO_STATS_MARK = "no stats"

# ===== 失败原因分类（2026-09-20 加）=====
#
# 为什么要分类：接口契约里「没拿到」一律是 None，前端只能**猜**原因 ——
# 结果它把**所有** None 都写成「Steam 限流」，而实测 4000+ 次请求一个 429 都没有，
# 失败全在 TLS / 读取层。用户拿着这句话去判断「是不是被限流了」，必然误判。
#
# 分类只做归类，**不改契约**（None 仍是 None）：结果单独走 stats 回传，
# 前端拿它决定①怎么措辞 ②要不要早停 ③下一批开多大。
#
# ⚠️ 匹配靠子串、大小写不敏感，判据来自 _fetch_json_ex 里两条 `last = ...`：
#    异常分支是 `type(e).__name__ + ": " + str(e)`，HTTP 分支是 `"HTTP%d " + body`。
#    所以像 "HTTP403 ..." / "TimeoutError: ..." / "SSLError: ..." 都能被识别。
# ⚠️ 顺序即优先级，先命中的算数，**别随意调换**：
#    "TimeoutError: _ssl.c:1076: The handshake operation timed out" 同时含
#    ssl 与 timed out —— 它本质是「等不到」，所以 timeout 必须排在 tls 前面。
# 每一项：(稳定的机器标识, 判定子串元组, 中文说明)
# ⚠️ 末尾那串纯数字是 Windows 的 winsock 错误码 —— 实测链路差时最常见的一条是
#    `URLError: <urlopen error [WinError 10060] connection attempt failed`（连接超时），
#    它既不含 "timeout" 也不含 "timed out"，只靠文字判据会掉进 other。
#    数字码在 Linux（云端）上不会出现，所以它们只是补充判据，不会误伤。
_ERROR_KINDS = (
    ("ratelimit", ("http429",), "被限流"),
    ("private",   ("profile is not public", "not public"), "档案不公开"),
    ("no_stats",  ("no stats",), "这款没有成就系统"),   # 上层已吃掉，这里只作兜底
    ("timeout",   ("timed out", "timeout", "10060", "connection attempt failed",
                   "read operation timed out"), "超时（对方无响应）"),
    # ⚠️ "TLS/SSL connection has been closed (EOF) (_ssl.c:992)" 是**云端链路抽风时
    #    最常见的一条**（2026-09-20 线上 /api/diag：openid 与 api 同时报这条）。
    #    它既不含 "sslerror" 也不含 "certificate"，只靠原来的判据会掉进 other ——
    #    而 other 不在链路层集合里，于是「首波早退」对最常见的情形反而失效。
    ("tls",       ("sslerror", "certificate", "wrong version number",
                   "tls/ssl", "ssl connection", "ssl handshake"), "加密连接失败"),
    ("refused",   ("connectionrefused", "connection reset", "connectionreset",
                   "broken pipe", "remote end closed", "connection aborted",
                   "10054", "10061"), "连接被中断"),
    ("dns",       ("nameresolution", "getaddrinfo", "name or service",
                   "11001", "11004"), "域名解析失败"),
)
_ERROR_OTHER = ("other", "其他错误")

# 标识 -> 中文说明。前端不直接用（前端按标识自己写更短的文案），
# 主要给日志和测试读，保证两侧对同一批标识的理解一致。
ERROR_LABELS = dict([(k, label) for k, _marks, label in _ERROR_KINDS])
ERROR_LABELS[_ERROR_OTHER[0]] = _ERROR_OTHER[1]

# 「链路层」失败：出现这些说明**请求根本没走通**，和「这款游戏本身的问题」
# （private / no_stats）性质完全不同 —— 前者该早停并提示稍后重试，
# 后者是确定性答案，重试一万次也一样。
CONNECTION_ERROR_KINDS = ("timeout", "tls", "refused", "dns", "ratelimit")


def classify_error(err):
    """把 _fetch_json_ex 的 err 串归成 (标识, 中文说明)。

    :param err  _fetch_json_ex 的第二个返回值；空串（成功）也别调，那是无意义的。
    :return     (kind, label)；认不出来归 ("other", "其他错误")。
    """
    s = (err or "").lower()
    if not s:
        return _ERROR_OTHER
    for kind, marks, label in _ERROR_KINDS:
        for m in marks:
            if m in s:
                return kind, label
    return _ERROR_OTHER

# ===== 出站节流 =====
# 两条独立的节流线，因为它们打的是两台机器、两套限流：
#   _throttle()        Web API（api.steampowered.com），官方约 1 请求/秒
#   _throttle_store()  商店网页接口（store.steampowered.com），宽松得多
_rate_lock = threading.Lock()
_last_call = [0.0]
_store_rate_lock = threading.Lock()
_last_store_call = [0.0]


def _throttle():
    with _rate_lock:
        now = time.time()
        wait = STEAM_MIN_INTERVAL - (now - _last_call[0])
        if wait > 0:
            time.sleep(wait)
        _last_call[0] = time.time()


def _throttle_store():
    with _store_rate_lock:
        now = time.time()
        wait = STORE_MIN_INTERVAL - (now - _last_store_call[0])
        if wait > 0:
            time.sleep(wait)
        _last_store_call[0] = time.time()


def _decompress(raw, encoding):
    """按 Content-Encoding 解压响应体。解压失败就原样返回，别把整个请求带崩。"""
    enc = (encoding or "").lower()
    try:
        if "gzip" in enc and raw[:2] == b"\x1f\x8b":
            return gzip.decompress(raw)
        if "deflate" in enc:
            try:
                return zlib.decompress(raw)
            except zlib.error:
                return zlib.decompress(raw, -zlib.MAX_WBITS)
    except Exception:
        return raw
    return raw


def _fetch_json_ex(url, timeout=20, retries=1, budget=None, throttle=None):
    """与 _fetch_json 同一套请求逻辑，但把**失败原因**一起返回：(data, err)。

    _fetch_json 为了「失败就是 None」这个简洁语义把错误吞掉了，绝大多数调用方
    也只需要它。但有调用方**必须**分清两种完全不同的失败：

        · Steam 明确回答「这款没有 stats」 -> 确定性答案，应当记账
        · 网络失败 / 限流 / 隐私设置        -> 真·不知道，下次重试

    所以实现放这里，_fetch_json 只是它的一层薄壳。
    err 是人可读的短字符串（HTTP 状态码 + 响应体片段，或异常类名）；成功为 ""。
    """
    # 不要用 ProxyHandler({}) 去绕过代理：云端沙箱和企业网络必须走代理，
    # 显式绕过会直接被对端重置连接（实测 ConnectionResetError 10054）。
    # 用默认 opener 即可 —— 有代理变量就走代理，没有就直连。
    opener = urllib.request.build_opener()
    headers = {
        "User-Agent": UA,
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
    }
    if budget:
        # 单次超时有个下限 MIN_ATTEMPT_TIMEOUT（再短就必然超时，试了也白试）。
        # 所以「按预算算出的单次超时」可能被这个下限抬回去 ——
        # 此时靠**砍重试次数**把总量拉回预算内，而不是让预算被冲破。
        # 预算是外层反向代理的断连底线，宁可少试一次也不能越线。
        gap = 1.2 * retries
        while retries > 0 and \
                (MIN_ATTEMPT_TIMEOUT * (retries + 1) + 1.2 * retries) > budget:
            retries -= 1
            gap = 1.2 * retries
        per = (budget - gap) / (retries + 1)
        timeout = max(MIN_ATTEMPT_TIMEOUT, min(timeout, per))

    wait = throttle or _throttle
    last = ""
    for attempt in range(retries + 1):
        wait()
        try:
            req = urllib.request.Request(url, headers=headers)
            with opener.open(req, timeout=timeout) as resp:
                raw = resp.read()
                enc = resp.headers.get("Content-Encoding", "")
            return json.loads(_decompress(raw, enc).decode("utf-8", "replace")), ""
        except urllib.error.HTTPError as e:
            # HTTP 层错误必须留下**响应体**：Steam 把「为什么拒绝」写在 body 里
            # （例如 {"playerstats":{"error":"Requested app has no stats"}}），
            # 只看状态码的话，「这款没成就」和「你没权限」完全分不开。
            try:
                body = e.read().decode("utf-8", "replace")[:200]
            except Exception:
                body = ""
            last = "HTTP%d %s" % (e.code, body)
        except Exception as e:
            last = "%s: %s" % (type(e).__name__, e)
        if attempt == retries:
            return None, last
        time.sleep(1.2)
    return None, last


def _fetch_json(url, timeout=20, retries=1, budget=None, throttle=None):
    """GET 一个返回 JSON 的地址。失败返回 None（调用方负责区分「失败」和「空」）。

    ⚠️ 超时预算是有硬上限的：外层反向代理大约 50 秒就会断连，
    所以「单次超时 × (重试次数+1) + 重试间隔」必须留在预算内，
    否则用户等到的是代理的 502/504 页面，而不是我们能解释的错误。

    budget：本次调用允许花掉的总秒数上限。给了它就自动收缩单次超时，
    保证 retries 次尝试能塞进预算 —— 因为「多试几次」比「每次等更久」
    更容易成功：实测同一秒里既有 47 秒彻底断流的失败，也有 6.7 秒成功的，
    说明瓶颈是链路偶发丢包，不是响应本身慢。

    gzip：跨境链路丢包时，「响应体大小」直接决定成败 —— 实测玩家资料这类小请求
    1 秒稳定返回，而游戏库那种上百 KB 的响应会被拖到 27~50 秒甚至超时。
    要 gzip 能把传输量压掉约 80%。urllib 不会自动解压，必须自己看 Content-Encoding。
    """
    return _fetch_json_ex(url, timeout, retries, budget, throttle)[0]


def probe(url, timeout=12):
    """
    探测某个外网地址是否可达 —— 只给 /api/diag 诊断接口用。

    与 _fetch_json 的关键区别：这里**不看返回内容**，只要拿到任何 HTTP
    响应就算「网络通」（403 / 404 也算通）。排查 Steam 授权失败时，
    必须能把「根本连不上」和「连上了但被拒绝」分开 —— 前者是服务端
    出网问题（用户做什么都没用），后者才是参数/签名问题。

    返回 {"ok": bool, "status": int, "ms": int, "error": str}
    """
    opener = urllib.request.build_opener()
    t0 = time.time()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with opener.open(req, timeout=timeout) as resp:
            resp.read(512)
            return {"ok": True, "status": getattr(resp, "status", 200),
                    "ms": int((time.time() - t0) * 1000), "error": ""}
    except urllib.error.HTTPError as e:
        # 收到 HTTP 响应说明链路是通的
        return {"ok": True, "status": e.code,
                "ms": int((time.time() - t0) * 1000), "error": ""}
    except Exception as e:
        return {"ok": False, "status": 0,
                "ms": int((time.time() - t0) * 1000),
                "error": "%s: %s" % (type(e).__name__, e)}


def probe_json(url, timeout=20, limit=400):
    """
    像 _fetch_json 一样真发一次请求，但**把失败原因原样带回来** —— 只给诊断用。

    为什么需要它：_fetch_json 把所有异常都收敛成 None，调用方只能知道「没拿到」，
    分不清是超时 / 被 HTTP 拒绝 / 返回了非 JSON（比如一页 HTML 错误页）。
    排查接口用法类问题（比如「多个 appid 拼起来还灵不灵」）时，
    这个区别就是全部答案。

    返回 {ok, status, bytes, encoding, parsed, ms, error, head}
    """
    opener = urllib.request.build_opener()
    headers = {
        "User-Agent": UA,
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
    }
    out = {"ok": False, "status": 0, "bytes": 0, "encoding": "",
           "parsed": False, "ms": 0, "error": "", "head": ""}
    t0 = time.time()
    try:
        req = urllib.request.Request(url, headers=headers)
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read()
            out["status"] = getattr(resp, "status", 200)
            out["bytes"] = len(raw)
            out["encoding"] = resp.headers.get("Content-Encoding", "")
        out["ok"] = True
        body = _decompress(raw, out["encoding"])
        try:
            json.loads(body.decode("utf-8", "replace"))
            out["parsed"] = True
        except Exception as e:
            out["error"] = "%s: %s" % (type(e).__name__, e)
            out["head"] = body[:limit].decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        out["status"] = e.code
        out["error"] = "HTTPError: %s" % e
        try:
            out["head"] = e.read()[:limit].decode("utf-8", "replace")
        except Exception:
            pass
    except Exception as e:
        out["error"] = "%s: %s" % (type(e).__name__, e)
    out["ms"] = int((time.time() - t0) * 1000)
    return out


# ===== 自定义 ID -> SteamID64 =====
def resolve_vanity(key, vanity, budget=None):
    """
    把自定义 ID（个人资料链接里 steamcommunity.com/id/xxx 的那个 xxx）
    解析成 17 位 SteamID64。

    返回 (steamid, error)：
        ("7656119...", "")   成功
        (None, "network")    连不上 Steam（不是「查无此人」）
        (None, "notfound")   确实没有这个自定义 ID

    必须区分后两者 —— 把「连不上」当「查无此人」报给用户，
    用户就会去反复检查自己的 ID 拼写，而问题其实在服务端出网。

    走的端点属于 api.steampowered.com，**不需要用户跳转去 Steam 授权**，
    这正是「手动填 ID」能绕开 steamcommunity.com 的原因。
    """
    url = ("%s/ISteamUser/ResolveVanityURL/v1/?key=%s&vanityurl=%s"
           % (API, key, urllib.parse.quote(vanity, safe="")))
    d = _fetch_json(url, timeout=15, retries=1, budget=budget)
    if d is None:
        return None, "network"
    resp = (d.get("response") or {})
    if resp.get("success") != 1:
        return None, "notfound"
    sid = resp.get("steamid")
    if not (sid and sid.isdigit()):
        return None, "notfound"
    return sid, ""


# ===== 玩家资料 =====
def get_player_summary(key, steamid, budget=None):
    """取昵称与头像。私密档案拿不到，返回 None。

    budget：总耗时上限（秒）。**凡是在别处「顺带」调用它的地方都必须给** ——
    昵称/头像纯属装饰，默认的 timeout=20 × (1 次重试) 最坏要 41 秒，
    足够把整个请求顶过反向代理约 50 秒的断连线（实测踩过一次：
    游戏库本身 15 秒就回来了，却因为这个字段总共耗时 55.9 秒）。
    """
    url = ("%s/ISteamUser/GetPlayerSummaries/v2/?key=%s&steamids=%s"
           % (API, key, steamid))
    # retries=1 是给「主要目的就是拿档案」的调用方（resolve / player）留的余量；
    # 给了 budget 时单次超时会自动收缩，重试次数仍由 budget 兜住。
    d = _fetch_json(url, timeout=20, retries=1, budget=budget)
    players = ((d or {}).get("response") or {}).get("players") or []
    if not players:
        return None
    p = players[0]
    return {
        "steamid": p.get("steamid"),
        "name": p.get("personaname"),
        "avatar": p.get("avatarfull") or p.get("avatarmedium") or p.get("avatar"),
        "profileUrl": p.get("profileurl"),
        "visibility": p.get("communityvisibilitystate"),  # 3 = 公开
    }


# ===== 游戏库 =====
#
# 两趟法：先要「带名称」，失败再要「不带名称」。
#
# 为什么要这么绕：带 include_appinfo 时响应体约 100 KB，跨境链路上会偶发断流
# （实测同一时段里，同一个请求既出现过 47 秒超时失败，也出现过 6.7 秒成功）。
# 去掉 appinfo 能把体积砍掉近一半 —— 名称和封面本来就能从商店接口补，
# 而商店结果缓存在公共表里、查一次大家都能用。
# 所以宁可用「没有名字的库」换「同步能成功」，也不要为了装饰性字段卡死整个同步。
#
# 预算分配（外层反向代理约 50 秒断连，留 5 秒余量）：
#   第一趟  34 秒（3 次尝试）  第二趟  10 秒（1 次尝试）  ≈ 44 秒 + 节流
_LIB_BUDGET_MAIN = 34
_LIB_BUDGET_LITE = 10


def _owned_games_url(key, steamid, with_appinfo=True):
    return ("%s/IPlayerService/GetOwnedGames/v1/?key=%s&steamid=%s"
            "%s&include_played_free_games=1&format=json"
            % (API, key, steamid, "&include_appinfo=1" if with_appinfo else ""))


def _parse_owned(d):
    """从 Steam 的响应里解析出 (games, is_private)；d 为 None 时返回 (None, False)。

    重要：用户把「游戏详情」设为私密时，Steam **不报错**，
    而是返回一个空的 response 对象。所以必须靠 games 键是否存在来判断，
    不能靠 HTTP 状态码或 error 字段。
    """
    if d is None:
        return None, False          # 网络/接口故障，和私密不是一回事
    resp = d.get("response")
    if not isinstance(resp, dict):
        return [], True
    games = resp.get("games")
    if games is None:
        return [], True             # 空 response = 游戏详情未公开
    return games, False


def get_owned_games(key, steamid):
    """
    返回 (games, is_private, names_ok)。

    names_ok=False 表示这次走的是「不带名称」的降级路径 ——
    游戏条目里没有 name / img_icon_url，调用方要靠商店接口补名称，
    并且**不要把空名称当成真名字写进库**。
    """
    d = _fetch_json(_owned_games_url(key, steamid, True),
                    timeout=20, retries=2, budget=_LIB_BUDGET_MAIN)
    games, is_private = _parse_owned(d)
    if games is not None:
        return games, is_private, True

    # 第一趟彻底失败：去掉 appinfo 再来一次，体积小一半、成功率明显更高
    d = _fetch_json(_owned_games_url(key, steamid, False),
                    timeout=15, retries=0, budget=_LIB_BUDGET_LITE)
    games, is_private = _parse_owned(d)
    if games is not None:
        return games, is_private, False

    return None, False, False


# ===== 成就 =====
def get_player_achievements_ex(key, steamid, appid, budget=None, throttle=None):
    """取玩家在某款游戏上的成就进度，**并把失败原因一起返回**：(结果, 原因标识)。

    返回值的第一个元素语义与 `get_player_achievements` 完全一致；第二个元素是
    `classify_error` 的标识：成功是 ""，确定性答案（这款没有成就）是 "no_stats"，
    真·失败是 timeout / tls / refused / dns / private / ratelimit / other。
    只有需要按原因做决策的调用方用它 —— 目前是并发批量（决定要不要早停）。

    返回三种结果，调用方**必须**区分开：
        {"earned": n, "total": m}   正常拿到
        {"earned": 0, "total": 0}   这两类确定性答案之一：
                                      · 这款游戏确实没有成就系统
                                      · Steam 明确说「这款没有 stats」（见下）
        None                        接口失败 / 被限流 / 档案不公开 —— 等于「不知道」

    为什么非要把后两种分开：把「不知道」当成「没有成就」写进库，
    这款游戏之后就会被永久跳过，「全成就 -> 已通关」这条自动规则就悄悄失效了。

    throttle：覆盖默认的出站节流，默认 None 表示用模块级的 _throttle。
    **并发批量场景（get_player_achievements_many）必须显式传 _no_throttle** ——
    否则那条全局锁会把并发池退化成串行，等于白开线程（见 config.STEAM_MIN_INTERVAL）。
    """
    url = ("%s/ISteamUserStats/GetPlayerAchievements/v1/?key=%s&steamid=%s&appid=%s&l=schinese"
           % (API, key, steamid, appid))
    d, err = _fetch_json_ex(url, timeout=15, retries=0, budget=budget, throttle=throttle)
    if not d:
        # 特例：Steam **明确回答**「Requested app has no stats」（HTTP 400）。
        # 那是确定性答案 —— 这款压根没有成就系统，不是「这次没问到」。
        #
        # 以前它和网络失败一起被当成「不知道」，后果很隐蔽：
        # 这些游戏每轮同步都被重问一遍（白烧一次配额），而且**永远**拿不到结果、
        # 永远占着每次同步有限的候选名额。实测用户库里 top-60 就有 6 款属于这类
        # （Godot Engine、Wallpaper Engine 之类，现在前端也把工具类排除掉了）。
        #
        # ⚠️ 只认这一条文案：隐私设置（"Profile is not public"）、限流、超时
        #    一律仍然是 None。把「档案不公开」当成「没有成就」会让整个库被
        #    误判成没有成就 —— 那是不可逆的数据污染。
        if _NO_STATS_MARK in (err or "").lower():
            return {"earned": 0, "total": 0}, "no_stats"
        kind, _label = classify_error(err)
        return None, kind                 # 网络或限流：不知道
    ps = d.get("playerstats") or {}
    achs = ps.get("achievements")
    if not achs:
        # 带 error 字段说明是「拿不到」（档案不公开、该游戏无权限等），
        # 不能当成「这款没成就」。Steam 把原因写在 body 里，正好用同一套分类 ——
        # 这样前端能分清「换个时间再试」和「你档案得公开」。
        if ps.get("error"):
            kind, _label = classify_error(str(ps.get("error")))
            return None, kind
        return {"earned": 0, "total": 0}, "no_stats"
    earned = 0
    for a in achs:
        if a.get("achieved") == 1:
            earned += 1
    return {"earned": earned, "total": len(achs)}, ""


def get_player_achievements(key, steamid, appid, budget=None, throttle=None):
    """取玩家在某款游戏上的成就进度（只返回值，丢掉原因）。

    返回三种结果，调用方**必须**区分开：
        {"earned": n, "total": m}   正常拿到
        {"earned": 0, "total": 0}   确定性答案：这款游戏确实没有成就系统
        None                        接口失败 / 被限流 / 档案不公开 —— 等于「不知道」

    为什么非要把后两种分开：把「不知道」当成「没有成就」写进库，
    这款游戏之后就会被永久跳过，「全成就 -> 已通关」这条自动规则就悄悄失效了。

    这是 `get_player_achievements_ex` 的薄壳，行为与以前逐字一致 ——
    需要原因（比如要按原因早停）时才用 _ex 那个。
    """
    return get_player_achievements_ex(key, steamid, appid, budget, throttle)[0]


def _no_throttle():
    """给并发池用的空节流 —— 并发度才是限流维度，改成等间隔会直接毁掉并发。"""
    return None


def get_player_achievements_many(key, steamid, appids, workers=None,
                                 deadline=None, item_budget=None, passes=2,
                                 stats=None):
    """并发取一批游戏的成就进度，返回 {appid: 结果}（值的语义同单个版本）。

    ## 为什么要有它（2026-09-20 实测，推翻旧设计）

    原来是**逐个串行**问 Steam，再叠上 `config.STEAM_MIN_INTERVAL` 的**全局串行节流**
    （同一时刻只允许一个请求在飞）→ 云端每款约 2.5 秒 → 全库要 10 分钟，
    再被 30 秒软截止切成"每轮只扫 60 款、要 4~6 次同步"。
    实测 Steam 那边：并发 32 跑完全库只要 **15.0 秒、零 429**。
    **慢是我们自己限流造成的，瓶颈不在 Steam。**

    ## 为什么分波，而不是一次 submit 全部

    整批的硬约束是"必须留在反向代理约 50 秒的断连线以内"。
    一次 submit 的话，池里排队的任务在截止之后**仍会继续跑完**，请求照样拖过 50 秒；
    分波之后每波之间能检查一次截止，到点就把剩余款如实报成 None 并直接收手。
    单波最坏耗时 = 该波的单款预算，所以整批耗时上界 ≈ `deadline` —— 这是可以证明的界。

    ## 为什么要跑第二趟（passes=2）

    跨境链路的失败是**偶发**的，而不是"这款问不到"。线上实测：同一批 60 款里 38 款报
    null，而把这 38 款串行重问，一半当场就有结果 —— 那些 null 属"这次没问到"，
    不是"没有成就"。可是契约里 None 的含义是**下次同步再试**，
    于是这批失败会让用户觉得"一次同步还是没扫完"。
    所以：第一趟跑完，**只把报 None 的那些再跑一趟**（成功的绝不重跑），
    用并发换成功率。重跑的是失败项，通常只剩几款，代价很小。

    ⚠️ 两趟必须**分时间**：第一趟只花 `_FIRST_PASS_SHARE` 那一份。否则第一趟会把时间
    用光（每波预算都取"距截止还剩多少"），第二趟永远开不了工，等于没写。
    ⚠️ 但剩余时间连一次尝试都塞不下时**不做预留** —— 否则会把本来能开工的第一趟
    也一起废掉（deadline 很短时见过这个反效果）。

    ## 链路差时为什么要**调低**单款预算（2026-09-20 加）

    这是「一批 60 款，尾巴整段拿不到」的解法。失败的请求要**等满预算**才肯放弃，
    所以单款预算直接决定「34 秒里塞得下几波」：

        预算 10s -> 34/10 ≈ 3 波 × 12 并发 ≈ 36 个槽位 -> 60 款里第 37~60 必然拿不到
        预算  4s -> 34/4  ≈ 8 波 × 12 并发 ≈ 96 个槽位 -> 全部款都有机会

    线上实测的 null 分布正是这个形状：差链路那批 60 款，null 集中在**第 41–60 槽位
    连成一片**（外加两个散点），总耗时 33.3s ≈ 截止时间 —— 不是随机失败，是尾部没轮到。
    健康时每波约 2 秒，根本不会触发降级；一旦触发，说明链路已经在丢包，
    此时「快速失败多次」比「每次慢慢等」更容易撞上能通的那几秒。

    ## 首波全灭为什么要早退（2026-09-20 加）

    链路整体断掉时，7 批 × 34 秒 = 4 分钟全在等超时（线上实测两条消息相隔 244 秒，
    就是这么来的），用户全程盯着进度条，最后只换来一句含糊的提示。
    第一波 12 个请求全失败**且原因全在链路层**，就足以判定「现在连不上 Steam」——
    直接收手，把剩余款如实报 None，让前端立刻给出准确提示。

    ⚠️ 早退的判据必须**限定在链路层**（timeout/tls/refused/dns/ratelimit）：
    若第一波恰好全是「档案不公开」的私有游戏，那是确定性答案，不是链路问题，
    早退会让后面本来能拿到的款白白丢掉。

    :param workers      在飞请求数上限，默认 `config.STEAM_MAX_CONCURRENCY`
    :param deadline     绝对时间戳（`time.time()` 口径）；None = 不限时（测试用）
    :param item_budget  单款出网预算上限（秒）；实际取 `min(item_budget, 距截止还剩多少)`
    :param passes       最多跑几趟（1 = 只跑一趟，不重试失败项）
    :param stats        可选 dict；会被填上本次的观测值（**不改返回值契约**）：
                          reasons  {原因标识: **款数**}，按款去重、只含最终仍为 None 的
                          link     "ok" | "degraded" | "down"
                          waves    实际跑了几波
                          skipped  因链路断 / 到点而**根本没问过**的款数
                          answered 拿到答案的款数
                          slots    请求的总槽位数
                        不变量：`answered + sum(reasons.values()) + skipped == slots`
                        （每款要么拿到、要么问过但失败、要么压根没轮到；有测试钉住）
                        调用方（app.py）把它转给前端，前端据此措辞与决定下一批多大。
    """
    out = {}
    reason_of = {}        # {appid: 最后一次失败的原因}；最后按「仍为 None 的款」去重统计
    link = "ok"
    waves = 0
    attempted = set()     # 真正发出过请求的款（失败也算）—— skipped 由它反推，避免重复计数
    budget_now = item_budget
    conn_kinds = set(CONNECTION_ERROR_KINDS)

    ids = [str(a) for a in (appids or [])]
    if not ids:
        if stats is not None:
            stats.update({"reasons": {}, "link": "ok", "waves": 0,
                          "skipped": 0, "answered": 0, "slots": 0})
        return out

    n = max(1, min(workers or STEAM_MAX_CONCURRENCY, len(ids)))
    total_passes = max(1, passes)
    todo = ids

    for p in range(total_passes):
        if not todo or link == "down":
            break
        if deadline is not None and deadline - time.time() < MIN_ATTEMPT_TIMEOUT:
            for a in todo:
                out.setdefault(a, None)
            break

        # 第一趟的收手线。给重试趟留一份时间，但留不下就别留（见上面第二条警告）。
        stop = deadline
        if deadline is not None and p == 0 and total_passes > 1:
            share = time.time() + (deadline - time.time()) * _FIRST_PASS_SHARE
            if share - time.time() >= MIN_ATTEMPT_TIMEOUT:
                stop = share

        for i in range(0, len(todo), n):
            wave = todo[i:i + n]
            budget = budget_now
            if stop is not None:
                left = stop - time.time()
                # 剩余时间连一次尝试都塞不下就别开工（再短也会被 _fetch_json 的下限抬回去，
                # 白白冲破 deadline）。这些款如实报 None —— 契约里 None 正是「不知道」。
                if left < MIN_ATTEMPT_TIMEOUT:
                    for a in wave:
                        out.setdefault(a, None)
                    continue
                budget = left if budget is None else min(budget, left)

            attempted.update(wave)   # 从现在起这些款算「问过了」（失败也算）

            # 用 _ex 版本，因为这一层要**按原因做决策**（早退 / 降级），
            # 而 get_player_achievements 那层已经把原因丢掉了。
            wave_res = {}
            with futures.ThreadPoolExecutor(max_workers=len(wave)) as ex:
                pending = {}
                for a in wave:
                    pending[ex.submit(get_player_achievements_ex, key, steamid, a,
                                      budget=budget, throttle=_no_throttle)] = a
                for f in futures.as_completed(pending):
                    try:
                        wave_res[pending[f]] = f.result()
                    except Exception:
                        # 单个 worker 出意外不能带崩整批：如实报「不知道」，下轮重试。
                        wave_res[pending[f]] = (None, "other")

            waves += 1
            answered = 0
            for a, pair in wave_res.items():
                r, kind = pair if isinstance(pair, tuple) else (pair, "other")
                out[a] = r
                if r is None:
                    reason_of[a] = kind           # 只记「最后一次」的原因，最后统一去重统计
                else:
                    reason_of.pop(a, None)        # 重跑成功了 -> 不再是失败
                    answered += 1
            failed = len(wave_res) - answered

            if p == 0 and i == 0 and answered == 0 and failed:
                # 首波全灭。只有在失败原因**全是链路层**时才判定「链路断」——
                # 全是「档案不公开」的话那是确定性答案，不该早退（见 docstring）。
                kinds = set(k for r, k in wave_res.values() if r is None)
                if kinds and kinds <= conn_kinds:
                    link = "down"
                    rest = todo[i + n:]
                    for a in rest:
                        out.setdefault(a, None)
                    log_link_down(kinds)
                    break
            elif failed and answered < len(wave) * 0.5:
                # 链路在抖：把单款预算压到下限，用「快速失败多次」换「更多槽位有机会」。
                if budget_now is None or budget_now > MIN_ATTEMPT_TIMEOUT:
                    budget_now = MIN_ATTEMPT_TIMEOUT
                if link == "ok":
                    link = "degraded"

        if p + 1 < total_passes:
            todo = [a for a in ids if out.get(a) is None]

    # ===== 收尾统计（2026-09-20 修掉两个重复计数）=====
    # ⚠️ reasons 必须**按款去重**、只数「最终仍然没拿到」的款。跑两趟时同一款会失败两次，
    #    直接在那两处累加会出现「42 款超时」却只有 38 个 null 的矛盾数字（线上实测踩到）。
    # ⚠️ skipped 同理不能在各处累加：同一批款会在两趟里各被「没轮到」一次，
    #    线上实测报出 skipped=41 而实际被问过的款数根本不支持这个数。
    #    改成用「总数 − 问过的款数」反推，语义清楚且不可能重复。
    reasons = {}
    for a in ids:
        if out.get(a) is None and a in reason_of:
            k = reason_of[a]
            reasons[k] = reasons.get(k, 0) + 1

    if stats is not None:
        stats.update({
            "reasons": reasons,
            "link": link,
            "waves": waves,
            "skipped": len(ids) - len(attempted),
            "answered": sum(1 for a in ids if out.get(a) is not None),
            "slots": len(ids),
        })
    return out


def log_link_down(kinds):
    """链路判定为「断」时打一行日志（原因集合是要留痕的，便于事后对时间线）。"""
    try:
        print("[gv] 成就批量：首波全灭且全为链路层失败 %s，已提前收手"
              % sorted(kinds), flush=True)
    except Exception:
        pass


# ===== 愿望单 =====
#
# `IWishlistService/GetWishlist/v1` 是 Steam 官方 Web API 里**未公开文档**的一个端点
# （steamapi.xpaw.me 上标着 UNDOCUMENTED），但它确实是官方域名下的正规接口，
# 而且**连 key 都不需要**（2026-09-20 实测：不带 key 连拉 3 次都是 200）。
# 我们仍然把 key 带上 —— 与其他调用保持一致，也便于出问题时归因到我们这把 key。
#
# ⚠️ 别再去找 `store.steampowered.com/wishlist/{profiles|id}/<x>/wishlistdata/`：
#    那两个老接口 **2024-11 就废弃了**，现在请求只会超时或被跳回商店首页
#    （实测 502 / 20 秒超时，不是网络问题）。愿望单现在只有这一条路。
#
# 返回的条目只有三个字段：appid / priority / date_added。
# **没有名字、没有封面** —— 名称和封面得另外走商店接口补（见 get_app_details_ex）。

_WISH_URL = ("%s/IWishlistService/GetWishlist/v1/?key=%s&steamid=%s")


def get_wishlist(key, steamid, budget=None):
    """取玩家的 Steam 愿望单。

    返回 (items, state)：

        (list, "ok")            拿到了。items = [{"appid": int,
                                                  "priority": int,
                                                  "addedTs": int}, ...]
                                priority 是用户在 Steam 里手动排的位次，0 = 没排过。
                                addedTs 是加入愿望单的时间戳（秒）。
        ([], "unavailable")     接口**明确回答**了，但一条都没有。
                                ⚠️ 注意这个状态的含义是「空 **或** 未公开」——
                                Steam 对这两种情况返回的东西**一模一样**
                                （`{"response":{}}`，连 items 键都没有），
                                所以**无法区分**。给用户的文案必须把两种可能都写上。
        (None, "error")         这次没问到答案（网络/链路）。调用方**不要**
                                把它当成「愿望单空了」——那会导致误删。

    ⚠️ 调用方拿到 "unavailable" 时**不要**直接清空本地的愿望单记录：
    用户可能只是把隐私设置从「公开」改成了「仅好友」，而 Steam 的返回
    与「真的清空了」完全一样。见 cloud.js 里 syncWishlist 的删除条件。

    budget：总耗时上限（秒），语义同 _fetch_json。
    """
    d = _fetch_json(_WISH_URL % (API, key, steamid),
                    timeout=20, retries=1, budget=budget)
    if d is None:
        return None, "error"
    resp = d.get("response")
    if not isinstance(resp, dict):
        return None, "error"
    raw = resp.get("items")
    if raw is None:
        # 没有 items 键 = 空 或 未公开（Steam 不区分，我们也分不了）
        return [], "unavailable"
    out = []
    for it in raw:
        appid = it.get("appid")
        if not appid:
            continue
        out.append({
            "appid": int(appid),
            "priority": it.get("priority") or 0,
            "addedTs": it.get("date_added") or 0,
        })
    return out, "ok"


# ===== 商店信息（公共数据）=====
def _parse_store_node(node):
    """把 appdetails 返回的单个节点整理成我们要的那几个字段；拿不到就 None。"""
    if not (isinstance(node, dict) and node.get("success") and node.get("data")):
        return None
    dd = node["data"]
    return {
        "name": dd.get("name"),
        "release": (dd.get("release_date") or {}).get("date"),
        "header": dd.get("header_image"),
        "genres": [x.get("description") for x in (dd.get("genres") or [])],
        "developers": dd.get("developers") or [],
    }


def store_url(appid, cc="cn", lang="schinese", filters=""):
    """拼商店接口的 URL。单独抽出来是为了让诊断端点能用同一套拼接去对比各种形态。"""
    extra = ("&filters=" + filters) if filters else ""
    return "%s?appids=%s&l=%s&cc=%s%s" % (STORE_API, appid, lang, cc, extra)


def get_app_details(appid, cc="cn", lang="schinese", filters=""):
    """
    取游戏的公共信息：名称、发售日期、封面、类型、开发商。
    这部分对所有人都是同一份，是「公共缓存表」的数据来源。

    ⚠️ 一次只能问一款。**批量拼 appids=1,2,3 会被 Steam 直接 400 拒绝**
    （实测：单款 200 / 多款 400，637ms 稳定复现，不是网络问题）。
    所以「把 400 多次请求压少」只能靠别的手段 —— 见下面 filters 和数据分层。

    ⚠️ **filters 必须留空（默认）。** 曾经想用 filters=basic 把响应体压小
    来对抗跨境链路，结果实测发现它砍掉的正是我们要的字段：
    570 返回 `release_date: null`、`genres: []`、`developers` 全没了。
    省下来的体积里装的就是发售年份和类型 —— 这个参数在这里不可用。
    重试时响应体大小只能靠「少问几款、分批多轮」来控制。
    """
    detail, _answered = get_app_details_ex(appid, cc, lang, filters)
    return detail


def get_app_details_ex(appid, cc="cn", lang="schinese", filters="", budget=None):
    """和 get_app_details 一样，但把「没拿到」和「确实没有」分开。

    返回 (detail, answered)：
        (dict, True)   拿到了
        (None, True)   Steam 明确回答「查不到这款」（下架 / 锁区）
        (None, False)  这次没拿到答案（网络 / 限流）—— 调用方不要把它记成已查过

    为什么非要分开：上层会把「已查过」持久化成 store_fetched 标记，
    一旦把偶发的网络失败也标上，那款游戏的封面/发售年就**永远**补不回来了。

    budget：批处理里由上层按「距离截止时间还剩多少」传进来，
    保证单款不会冲破整个批次的软截止（否则 34 秒的截止会因最后一个
    卡住的请求变成 50 秒，白等还容易被反向代理掐断）。
    """
    # timeout 压到 8 秒：一次健康的商店请求约 0.6 秒，8 秒已经很宽松；
    # 而链路抽风时超时会拖很久，压小才能让上层 STORE_DEADLINE 多覆盖几款。
    # retries=1 是留一次机会 —— 偶发 TLS 断连重试一次往往就过了。
    d = _fetch_json(store_url(appid, cc, lang, filters),
                    timeout=8, retries=1, throttle=_throttle_store,
                    budget=budget)
    if d is None:
        return None, False
    node = d.get(str(appid))
    if node is None:
        # 响应里连这个 key 都没有，说明不是「查不到」而是这次没答全
        return None, False
    return _parse_store_node(node), True


# 曾经写过一个 get_app_details_batch（一次问多款），已经删掉：
# 实测 Steam 对 appids=1,2,3 这种逗号拼接**直接返回 400**，
# 单款却正常 200。留着它只会让每次商店请求先白跑一轮注定失败的批量、
# 再退化成逐个 —— 既不省钱也不省时间。批量方案本身不成立。
#
# 真正可行的提速手段只有两条，都已在别处实现：
#   1. 商店接口单独用更短的出站间隔（见 config.STORE_MIN_INTERVAL）
#   2. 结果按 appid 缓存进公共表（game_meta），一个人查过别人就不用再查
# ⚠️ 不要再用 filters=basic —— 它确实能压小响应体，但会连
#    release_date / genres / developers 一起砍掉（实测 570 返回 release:null），
#    而「发售年份 + 类型」正是我们问商店的目的（见 get_app_details 注释）。
