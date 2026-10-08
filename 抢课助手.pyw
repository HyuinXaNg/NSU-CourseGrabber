# -*- coding: utf-8 -*-
"""
抢课助手 — 桌面窗口版
================================================================================
一个真正的桌面窗口程序：点「▶ 开始抢课」按钮，它自己打开 Chrome、执行抢课，
并把「是否抢到」显示在窗口里。

工作方式（重要）
--------------------------------------------------------------------------------
本程序**不重写抢课逻辑**。它只做两件事：
    1. 用 Playwright 打开一个 Chrome 窗口，你在这个窗口里手动登录教务系统；
    2. 把已经过 12 轮修复、21 项测试的 grab_course.gui.js 注入页面，
       点按钮时调 __GRAB_GUI__.start()，然后轮询 __GRAB_GUI__.result()
       把结果显示在桌面窗口上。

好处：抢课逻辑始终只有一份（那个被测试覆盖的 JS），桌面窗口只是个遥控器。
另外：程序**不接触你的账号密码**，登录完全由你在 Chrome 里手动完成。

依赖：playwright（已安装）+ 本机 Chrome
================================================================================
"""

import os
import queue
import sys
import threading
import tkinter as tk
from tkinter import font as tkfont

# ---------------------------------------------------------------- 路径与常量

HERE = os.path.dirname(os.path.abspath(__file__))
JS_FILE = os.path.join(HERE, "grab_course.gui.js")
PROFILE_DIR = os.path.join(HERE, ".chrome-profile")
CONFIG_FILE = os.path.join(HERE, "抢课助手配置.json")

DEFAULT_URL = "https://xk.dnui.edu.cn/xsxk/elective/grablesson"

# 配色
C_BG = "#f7f9fc"
C_CARD = "#ffffff"
C_BORDER = "#d9e1ec"
C_TEXT = "#1f2d3d"
C_SUB = "#5a6b80"
C_ACCENT = "#2d6cdf"
C_OK = "#0f9d58"
C_FAIL = "#d93025"
C_WAIT = "#e37400"

POLL_MS = 120  # UI 轮询消息队列的间隔


def load_config():
    import json
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}
    cfg.setdefault("url", DEFAULT_URL)
    cfg.setdefault("keywords", "羽毛球")
    cfg.setdefault("at_time", "")
    cfg.setdefault("dry_run", False)
    return cfg


def save_config(cfg):
    import json
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


# ============================================================================
#  后台工作线程：独占 Playwright（Playwright 的同步 API 必须在同一线程里用）
# ============================================================================

class Worker(threading.Thread):
    """负责启动 Chrome、注入脚本、执行抢课、回报状态。

    与 UI 之间只通过两个队列通信：
        ui_q  : 工作线程 -> UI       ("log", str) / ("result", dict) / ("phase", str)
        cmd_q : UI -> 工作线程       ("start",) ("stop",) ("inject",) ("goto", url) ("quit",)
    """

    def __init__(self, ui_q, cmd_q, url, headless=False, profile_dir=None):
        super().__init__(daemon=True)
        self.ui_q = ui_q
        self.cmd_q = cmd_q
        self.url = url
        self.headless = headless
        self.profile_dir = profile_dir or PROFILE_DIR
        self._quit = False
        self.page = None

    # ---- 给 UI 发消息的小工具 ----
    def log(self, msg):
        self.ui_q.put(("log", msg))

    def phase(self, p, detail=""):
        self.ui_q.put(("phase", (p, detail)))

    # ---- 主循环 ----
    def run(self):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            self.log("没有安装 playwright。请在命令行执行：python -m pip install playwright")
            self.phase("error", "缺少 playwright")
            return

        try:
            with sync_playwright() as p:
                self.log("正在启动 Chrome…")
                self.phase("launching")
                ctx = p.chromium.launch_persistent_context(
                    self.profile_dir,
                    channel="chrome",
                    headless=self.headless,
                    no_viewport=True,
                    args=["--start-maximized"],
                )
                page = ctx.pages[0] if ctx.pages else ctx.new_page()

                self.log("正在打开选课网址…")
                try:
                    page.goto(self.url, wait_until="domcontentloaded", timeout=60000)
                except Exception as e:
                    self.log(f"打开网址失败：{e}")
                    self.log("浏览器仍然可用 —— 请在里面手动打开选课页面，再点「注入脚本」")

                self.phase("need_login")
                self.log("请在弹出的 Chrome 里登录教务系统，并切到「体育项目」标签页")
                self.log("登录完成后，点上面的「▶ 开始抢课」")

                self.loop(ctx, page)

                try:
                    ctx.close()
                except Exception:
                    pass
        except Exception as e:
            self.log(f"启动浏览器出错：{type(e).__name__}: {e}")
            self.phase("error", str(e))

    # ---- 命令处理 + 结果轮询 ----
    def loop(self, ctx, page):
        last_result = None
        while not self._quit:
            try:
                cmd = self.cmd_q.get(timeout=0.4)
            except queue.Empty:
                cmd = None

            if cmd:
                kind = cmd[0]
                try:
                    if kind == "quit":
                        self._quit = True
                        return
                    elif kind == "goto":
                        self.url = cmd[1]
                        page.goto(self.url, wait_until="domcontentloaded", timeout=60000)
                        self.page = page
                    elif kind == "setopts":
                        # 把桌面窗口里的设置同步给页面脚本。
                        # 不做这一步的话，页面会用自己 localStorage 里的旧值，
                        # 你在窗口里改的关键词/准点时间会被无声忽略。
                        kw, at, dry = cmd[1], cmd[2], cmd[3]
                        page.evaluate(
                            "([kw, at, dry]) => {"
                            "  const s = window.__GRAB_GUI__ && window.__GRAB_GUI__.settings;"
                            "  if (s) { s.keywords = kw; s.atTime = at; s.dryRun = dry; }"
                            "}",
                            [kw, at, dry],
                        )
                    elif kind == "inject":
                        self.inject(page)
                    elif kind == "start":
                        self.inject(page)
                        # 不能 await：start() 内部可能要等到准点，会把 evaluate 卡住
                        page.evaluate("() => { if (window.__GRAB_GUI__) __GRAB_GUI__.start(); }")
                        self.log("已在页面中启动抢课")
                    elif kind == "stop":
                        page.evaluate("() => { if (window.__GRAB_GUI__) __GRAB_GUI__.stop(); }")
                        self.log("已请求停止")
                    elif kind == "grab":
                        page.evaluate(
                            "(i) => { if (window.__GRAB_GUI__) __GRAB_GUI__.grab(i); }", cmd[1]
                        )
                except Exception as e:
                    self.log(f"命令 {kind} 执行失败：{type(e).__name__}: {e}")

            # 轮询页面里的结果
            try:
                page = self.pick_page(ctx, page)
                r = page.evaluate("() => (window.__GRAB_GUI__ ? __GRAB_GUI__.result() : null)")
                if r != last_result:
                    last_result = r
                    self.ui_q.put(("result", r))
            except Exception:
                # 页面正在跳转时 evaluate 会抛错，忽略即可，下一轮再试
                pass

    # ---- 挑选"当前该操作哪个标签页" ----
    def pick_page(self, ctx, fallback):
        try:
            pages = [p for p in ctx.pages if not p.is_closed()]
        except Exception:
            return fallback
        if not pages:
            return fallback
        # 优先选 URL 里含目标站点的页面
        host = self.url.split("//")[-1].split("/")[0]
        for p in pages:
            try:
                if host and host in (p.url or ""):
                    return p
            except Exception:
                pass
        # 其次选不是 about:blank 的
        for p in pages:
            try:
                if (p.url or "") not in ("about:blank", ""):
                    return p
            except Exception:
                pass
        return pages[-1]

    # ---- 注入 grab_course.gui.js ----
    def inject(self, page):
        if not os.path.exists(JS_FILE):
            self.log(f"找不到脚本文件：{JS_FILE}")
            return False
        try:
            already = page.evaluate("() => !!window.__GRAB_GUI__")
        except Exception:
            already = False

        if already:
            self.log("页面里已存在抢课界面，跳过注入")
            return True

        try:
            with open(JS_FILE, "r", encoding="utf-8") as f:
                code = f.read()
        except Exception as e:
            self.log(f"读取脚本失败：{e}")
            return False

        try:
            page.evaluate(code)
            ok = page.evaluate("() => !!window.__GRAB_GUI__")
            if ok:
                self.log("脚本注入成功")
            else:
                self.log("注入后没找到 __GRAB_GUI__ —— 可能当前标签页不是选课页面")
            return ok
        except Exception as e:
            self.log(f"注入失败：{type(e).__name__}: {e}")
            return False

    def quit(self):
        self._quit = True
        self.cmd_q.put(("quit",))


# ============================================================================
#  桌面窗口
# ============================================================================

class App:
    def __init__(self, root):
        self.root = root
        self.cfg = load_config()
        self.ui_q = queue.Queue()
        self.cmd_q = queue.Queue()
        self.worker = None

        root.title("🏸 抢课助手")
        root.geometry("560x640")
        root.minsize(520, 560)
        root.configure(bg=C_BG)

        self.f_big = tkfont.Font(family="Microsoft YaHei UI", size=17, weight="bold")
        self.f_mid = tkfont.Font(family="Microsoft YaHei UI", size=10, weight="bold")
        self.f_norm = tkfont.Font(family="Microsoft YaHei UI", size=10)
        self.f_small = tkfont.Font(family="Microsoft YaHei UI", size=9)

        self._build()
        self._start_worker()
        self.root.after(POLL_MS, self._pump)
        root.protocol("WM_DELETE_WINDOW", self._on_close)

    # ---------------------------------------------------------------- 界面
    def _build(self):
        pad = {"padx": 14}

        # ---------- 结果大卡片 ----------
        self.result_card = tk.Frame(self.root, bg="#f0f3f8", highlightthickness=1,
                                    highlightbackground=C_BORDER)
        self.result_card.pack(fill="x", pady=(14, 10), **pad)
        self.result_main = tk.Label(self.result_card, text="⏳ 未开始", bg="#f0f3f8",
                                    fg=C_SUB, font=self.f_big)
        self.result_main.pack(pady=(14, 2))
        self.result_sub = tk.Label(self.result_card, text="正在启动浏览器…", bg="#f0f3f8",
                                   fg=C_SUB, font=self.f_norm, wraplength=480, justify="center")
        self.result_sub.pack(pady=(0, 14))

        # ---------- 输入区 ----------
        form = tk.Frame(self.root, bg=C_BG)
        form.pack(fill="x", **pad)

        tk.Label(form, text="选课网址", bg=C_BG, fg=C_SUB, font=self.f_small).pack(anchor="w")
        self.url_var = tk.StringVar(value=self.cfg["url"])
        tk.Entry(form, textvariable=self.url_var, font=self.f_norm).pack(fill="x", ipady=3)

        row = tk.Frame(form, bg=C_BG)
        row.pack(fill="x", pady=(8, 0))
        left = tk.Frame(row, bg=C_BG)
        left.pack(side="left", fill="x", expand=True)
        tk.Label(left, text="课程关键词", bg=C_BG, fg=C_SUB, font=self.f_small).pack(anchor="w")
        self.kw_var = tk.StringVar(value=self.cfg["keywords"])
        tk.Entry(left, textvariable=self.kw_var, font=self.f_norm).pack(fill="x", ipady=3)

        right = tk.Frame(row, bg=C_BG)
        right.pack(side="left", fill="x", expand=True, padx=(10, 0))
        tk.Label(right, text="准点开抢（留空=点按钮立即抢）", bg=C_BG, fg=C_SUB,
                 font=self.f_small).pack(anchor="w")
        self.at_var = tk.StringVar(value=self.cfg["at_time"])
        tk.Entry(right, textvariable=self.at_var, font=self.f_norm).pack(fill="x", ipady=3)

        self.dry_var = tk.BooleanVar(value=self.cfg["dry_run"])
        tk.Checkbutton(form, text="演练模式（只识别不点击，先确认能认对课程）",
                       variable=self.dry_var, bg=C_BG, fg=C_SUB, font=self.f_small,
                       activebackground=C_BG, selectcolor=C_CARD).pack(anchor="w", pady=(8, 0))

        # ---------- 主按钮 ----------
        self.start_btn = tk.Button(self.root, text="▶  开始抢课", font=self.f_big,
                                   bg=C_ACCENT, fg="white", activebackground="#2559b8",
                                   activeforeground="white", relief="flat", cursor="hand2",
                                   command=self.on_start)
        self.start_btn.pack(fill="x", pady=(12, 6), ipady=9, **pad)

        subrow = tk.Frame(self.root, bg=C_BG)
        subrow.pack(fill="x", **pad)
        self.inject_btn = tk.Button(subrow, text="🔄 注入脚本", font=self.f_mid,
                                    bg=C_CARD, fg=C_TEXT, relief="flat", cursor="hand2",
                                    highlightthickness=1, highlightbackground=C_BORDER,
                                    command=self.on_inject)
        self.inject_btn.pack(side="left", fill="x", expand=True, ipady=5)
        self.stop_btn = tk.Button(subrow, text="■ 停止", font=self.f_mid,
                                  bg=C_CARD, fg=C_TEXT, relief="flat", cursor="hand2",
                                  highlightthickness=1, highlightbackground=C_BORDER,
                                  command=self.on_stop)
        self.stop_btn.pack(side="left", fill="x", expand=True, ipady=5, padx=(8, 0))
        self.goto_btn = tk.Button(subrow, text="🌐 打开网址", font=self.f_mid,
                                  bg=C_CARD, fg=C_TEXT, relief="flat", cursor="hand2",
                                  highlightthickness=1, highlightbackground=C_BORDER,
                                  command=self.on_goto)
        self.goto_btn.pack(side="left", fill="x", expand=True, ipady=5, padx=(8, 0))

        # ---------- 日志 ----------
        tk.Label(self.root, text="日志", bg=C_BG, fg=C_SUB, font=self.f_small).pack(
            anchor="w", pady=(12, 2), **pad)
        logwrap = tk.Frame(self.root, bg=C_BG)
        logwrap.pack(fill="both", expand=True, pady=(0, 14), **pad)
        self.log_text = tk.Text(logwrap, font=("Consolas", 9), bg="#1f2d3d", fg="#c8d6e5",
                                relief="flat", wrap="word", height=8, insertbackground="#c8d6e5")
        self.log_text.pack(side="left", fill="both", expand=True)
        sb = tk.Scrollbar(logwrap, command=self.log_text.yview)
        sb.pack(side="right", fill="y")
        self.log_text.configure(yscrollcommand=sb.set, state="disabled")

    # ---------------------------------------------------------------- 日志
    def log(self, msg):
        import time
        line = time.strftime("%H:%M:%S ") + str(msg)
        self.log_text.configure(state="normal")
        self.log_text.insert("end", line + "\n")
        self.log_text.see("end")
        # 只保留最近 300 行
        if int(self.log_text.index("end-1c").split(".")[0]) > 300:
            self.log_text.delete("1.0", "100.0")
        self.log_text.configure(state="disabled")
        # .pyw 由 pythonw 启动时没有控制台，sys.stdout 是 None。
        # CPython 下 print 遇到 None 会静默返回，但个别环境会抛错，这里兜住。
        try:
            print(line)
        except Exception:
            pass

    # ---------------------------------------------------------------- 结果渲染
    def render_result(self, r):
        if not r:
            return
        state = r.get("state", "idle")
        course = r.get("course") or ""
        teacher = r.get("teacher") or ""
        detail = r.get("detail") or ""

        styles = {
            "ok":   ("✅ 抢课成功", "#e8f6ee", "#a8dcc0", C_OK),
            "fail": ("⛔ 未抢到",   "#fdecea", "#f5b5ae", C_FAIL),
            "run":  ("🔄 抢课中…",  "#eef4ff", "#c7dbff", C_ACCENT),
            "wait": ("⏳ 待命中",   "#fff6e5", "#ffd699", C_WAIT),
            "idle": ("⏳ 未开始",   "#f0f3f8", "#dde4ee", C_SUB),
        }
        main, bg, bd, fg = styles.get(state, styles["idle"])

        if state == "ok":
            sub = f"{course} / {teacher}\n{detail}"
        elif state == "fail":
            sub = detail
        else:
            sub = detail or ""

        self.result_main.configure(text=main, fg=fg)
        self.result_sub.configure(text=sub, fg=fg)
        self.result_card.configure(bg=bg, highlightbackground=bd)
        self.result_main.configure(bg=bg)
        self.result_sub.configure(bg=bg)

    # ---------------------------------------------------------------- 与工作线程
    def _start_worker(self):
        self.worker = Worker(self.ui_q, self.cmd_q, self.url_var.get().strip() or DEFAULT_URL)
        self.worker.start()

    def _pump(self):
        """主线程定时把工作线程的消息取出来更新界面（Tkinter 只能在主线程改）"""
        try:
            while True:
                kind, payload = self.ui_q.get_nowait()
                if kind == "log":
                    self.log(payload)
                elif kind == "result":
                    self.render_result(payload)
                elif kind == "phase":
                    p, detail = payload
                    if p == "launching":
                        self.result_main.configure(text="⏳ 正在启动浏览器…")
                    elif p == "need_login":
                        self.result_main.configure(text="👉 请先在浏览器里登录")
                        self.result_sub.configure(text=detail or "登录后点上面的「▶ 开始抢课」")
                    elif p == "error":
                        self.render_result({"state": "fail", "detail": detail or "启动失败"})
        except queue.Empty:
            pass
        self.root.after(POLL_MS, self._pump)

    # ---------------------------------------------------------------- 按钮动作
    def _persist(self):
        save_config({
            "url": self.url_var.get().strip(),
            "keywords": self.kw_var.get().strip(),
            "at_time": self.at_var.get().strip(),
            "dry_run": bool(self.dry_var.get()),
        })

    def on_start(self):
        self._persist()
        if not self.worker or not self.worker.is_alive():
            self.log("工作线程不在了，正在重启…")
            self._start_worker()
        kw = self.kw_var.get().strip()
        at = self.at_var.get().strip()
        self.cmd_q.put(("setopts", kw, at, bool(self.dry_var.get())))
        self.cmd_q.put(("start",))
        self.log(f"开始抢课：关键词「{kw}」" + (f"，准点 {at}" if at else "，立即开抢"))
        self.render_result({"state": "run", "detail": "正在扫描并抢课…"})

    def on_stop(self):
        self.cmd_q.put(("stop",))

    def on_inject(self):
        self.cmd_q.put(("inject",))

    def on_goto(self):
        url = self.url_var.get().strip()
        if url:
            self._persist()
            self.cmd_q.put(("goto", url))
            self.log(f"正在打开：{url}")

    def _on_close(self):
        self._persist()
        try:
            if self.worker:
                self.worker.quit()
        except Exception:
            pass
        self.root.destroy()


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
