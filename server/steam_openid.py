# -*- coding: utf-8 -*-
"""
Steam OpenID 2.0 —— 只做两件事：造跳转地址、验签拿 SteamID64。

为什么必须走服务端：
  1) 验签要 POST 回 Steam，浏览器直接做会有跨域问题；
  2) Steam 官方明确要求整个授权过程是**浏览器整页跳转**，
     不能放进 iframe / 内嵌容器里（这也是它做不成微信小程序的原因）。

本模块不持有任何密钥，只依赖 Steam 的公开 OpenID 端点。
"""

import re
import secrets
import time
import urllib.parse
import urllib.request

from config import STEAM_OPENID_ENDPOINT, UA

# claimed_id 形如 https://steamcommunity.com/openid/id/<SteamID64>（17 位数字）
# ⚠️ 示例用占位符，不印真实 ID —— server/ 会被整目录打包上线。
CLAIMED_ID_RE = re.compile(r"/openid/id/(\d{17})")

# 同一账号可能绑定多个 OpenID，Steam 固定返回这一串
IDENTIFIER_SELECT = "http://specs.openid.net/auth/2.0/identifier_select"


def new_state():
    """一次性随机串，用于防跨站伪造（CSRF）。"""
    return secrets.token_urlsafe(18)


def build_login_url(return_to, realm):
    """拼出跳转到 Steam 授权页的完整地址。"""
    params = {
        "openid.ns": "http://specs.openid.net/auth/2.0",
        "openid.mode": "checkid_setup",
        "openid.return_to": return_to,
        "openid.realm": realm,
        "openid.identity": IDENTIFIER_SELECT,
        "openid.claimed_id": IDENTIFIER_SELECT,
    }
    return STEAM_OPENID_ENDPOINT + "?" + urllib.parse.urlencode(params)


def verify(query_items, timeout=40, retries=2):
    """
    把 Steam 回调带回来的 openid.* 参数原样送回 Steam 验签。

    参数 query_items 是 [(k, v), ...]（保留原始顺序，避免丢重复键）。

    返回 {"ok": bool, "steamid": str|None, "reason": str, "detail": str}

    reason 的取值就是排查线索，前端会照着它给用户不同的提示：
        "ok"        验签通过
        "no_params" 回调里没有 openid.* 参数（多半是用户直接访问了这个地址）
        "network"   **一次都没连上 Steam** —— 服务端出网问题，
                    用户重试多少次都没用（典型：沙箱在国内，
                    steamcommunity.com 被墙）。这不是用户的错。
        "invalid"   连上了，但 Steam 明确回复签名无效
        "no_id"     验签通过，却没能从 claimed_id 里解析出 SteamID64
    """
    payload = [(k, v) for (k, v) in query_items if k.startswith("openid.")]
    if not payload:
        return {"ok": False, "steamid": None,
                "reason": "no_params", "detail": ""}

    # 覆盖 mode，这是验签的开关
    payload = [(k, v) for (k, v) in payload if k != "openid.mode"]
    payload.append(("openid.mode", "check_authentication"))

    body = urllib.parse.urlencode(payload).encode("utf-8")
    # 同 steam_client：不绕过代理，否则云端沙箱里会被重置连接
    opener = urllib.request.build_opener()

    text = None
    last_err = ""
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(
                STEAM_OPENID_ENDPOINT,
                data=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": UA,
                },
            )
            with opener.open(req, timeout=timeout) as resp:
                text = resp.read().decode("utf-8", "replace")
            break
        except Exception as e:
            last_err = "%s: %s" % (type(e).__name__, e)
            text = None
            if attempt < retries:
                time.sleep(1.5)

    if text is None:
        # 连都没连上 —— 必须和「验签失败」分开报，否则用户会一直
        # 以为是自己操作的问题，反复重试。
        return {"ok": False, "steamid": None,
                "reason": "network", "detail": last_err}

    # Steam 返回的是 "is_valid:true" 这样的纯文本，不是 JSON
    if "is_valid:true" not in text.replace(" ", ""):
        return {"ok": False, "steamid": None, "reason": "invalid", "detail": ""}

    claimed = ""
    for k, v in query_items:
        if k == "openid.claimed_id":
            claimed = v
            break

    m = CLAIMED_ID_RE.search(claimed or "")
    if not m:
        return {"ok": False, "steamid": None, "reason": "no_id", "detail": ""}

    return {"ok": True, "steamid": m.group(1), "reason": "ok", "detail": ""}
