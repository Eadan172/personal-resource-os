"""拟人浏览器回退（P3）：真实浏览器渲染 + 拟人鼠标操作关闭登录/二维码弹窗。

典型场景：知乎专栏静态抓取返回 zse-ck 反爬挑战（403），需要：
1. 真实浏览器内核加载页面，执行 JS 挑战；
2. 弹出「扫码登录」二维码弹窗时，模拟真人鼠标移动轨迹点击关闭按钮；
3. 读取渲染后的完整正文 HTML。

依赖（可选）：pip install playwright && playwright install chromium
未安装时给出面向普通用户的安装提示，不影响核心其他功能。
"""
from __future__ import annotations

import math
import random
import time

from .common import IngestError, USER_AGENT

# 常见「登录/二维码弹窗」关闭按钮选择器（知乎、CSDN、简书、掘金等）
_CLOSE_SELECTORS = [
    ".Modal-closeButton",            # 知乎登录弹窗
    "button[aria-label='关闭']",
    "[aria-label='Close']",
    ".close-icon", ".modal-close", ".login-dialog .close",
    ".signFlowModal .Modal-closeButton",
    "button.close", ".ant-modal-close",
]
_TIMEOUT_MS = 45_000


def _human_mouse_path(x0: float, y0: float, x1: float, y1: float,
                      steps: int = 25) -> list[tuple[float, float]]:
    """生成拟人鼠标轨迹：三次贝塞尔曲线 + 随机抖动 + 先快后慢。"""
    cx, cy = (x0 + x1) / 2 + random.uniform(-80, 80), (y0 + y1) / 2 + random.uniform(-80, 80)
    pts = []
    for i in range(1, steps + 1):
        t = i / steps
        t = t * t * (3 - 2 * t)  # smoothstep：起步慢、中间快、到达慢
        x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t ** 2 * x1 + random.uniform(-2, 2)
        y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t ** 2 * y1 + random.uniform(-2, 2)
        pts.append((x, y))
    return pts


def human_click(page, selector: str) -> bool:
    """拟人点击：先把鼠标沿曲线移动到元素中心（带抖动），停顿后按下。"""
    try:
        el = page.query_selector(selector)
        if not el or not el.is_visible():
            return False
        box = el.bounding_box()
        if not box:
            return False
        x1 = box["x"] + box["width"] / 2 + random.uniform(-3, 3)
        y1 = box["y"] + box["height"] / 2 + random.uniform(-3, 3)
        # 起点：视口内随机位置（模拟鼠标本来就在页面上）
        x0, y0 = random.uniform(100, 500), random.uniform(100, 400)
        for x, y in _human_mouse_path(x0, y0, x1, y1):
            page.mouse.move(x, y)
            time.sleep(random.uniform(0.004, 0.018))
        time.sleep(random.uniform(0.08, 0.25))  # 真人按下前的迟疑
        page.mouse.down()
        time.sleep(random.uniform(0.03, 0.09))
        page.mouse.up()
        return True
    except Exception:
        return False


def dismiss_login_popups(page, rounds: int = 3) -> list[str]:
    """多轮尝试关闭登录/二维码弹窗，返回点掉的弹窗选择器。"""
    closed = []
    for _ in range(rounds):
        for sel in _CLOSE_SELECTORS:
            if human_click(page, sel):
                closed.append(sel)
                time.sleep(random.uniform(0.4, 0.9))
        # 有的站点弹窗只能按 Esc 关闭
        page.keyboard.press("Escape")
        time.sleep(random.uniform(0.2, 0.5))
    return closed


def fetch_with_browser(url: str, headless: bool = True, scroll: int | None = None,
                       progress=None) -> str:
    """浏览器渲染抓取：加载页面 → 拟人关闭登录弹窗 → 滚动触发懒加载 → 返回 HTML。

    scroll：拟人滚动次数（抓取深度，P3 可配置）；缺省随机 3–6 次，长文建议 8–12。
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise IngestError(
            "该网页有反爬保护，需要浏览器渲染才能读取。请按以下步骤安装浏览器组件后重试：\n"
            "  1) pip install playwright\n"
            "  2) playwright install chromium\n"
            "（一次性安装，之后所有类似网页都能自动采集）"
        )
    rounds = scroll if scroll and scroll > 0 else random.randint(3, 6)
    if progress:
        progress(f"浏览器渲染（拟人滚动 {rounds} 次）…")
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=headless)
        ctx = browser.new_context(user_agent=USER_AGENT, viewport={"width": 1366, "height": 850},
                                  locale="zh-CN")
        page = ctx.new_page()
        try:
            page.goto(url, timeout=_TIMEOUT_MS, wait_until="domcontentloaded")
            page.wait_for_timeout(random.randint(1500, 3000))  # 等 JS 挑战/首屏渲染
            dismiss_login_popups(page)
            # 拟人滚动：触发懒加载内容（知乎/公众号等）
            for _ in range(rounds):
                page.mouse.wheel(0, random.randint(400, 900))
                page.wait_for_timeout(random.randint(400, 900))
            page.wait_for_load_state("networkidle", timeout=10_000)
        except Exception:
            pass  # 部分资源加载失败不阻塞，能拿到多少算多少
        html = page.content()
        browser.close()
    return html
