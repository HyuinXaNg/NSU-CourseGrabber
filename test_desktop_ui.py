# -*- coding: utf-8 -*-
"""
桌面版 UI 层测试（不启动浏览器）
================================================================================
用桩对象替换 Worker，只验证界面本身：
  1. 窗口能构造出来，关键控件都在
  2. 结果大卡片四种状态的文字与配色正确
  3. 点「开始抢课」会把 setopts + start 两条命令投递出去
     （其中 setopts 很关键 —— 漏了它，窗口里改的关键词会被页面脚本忽略）

用法：python test_desktop_ui.py
"""

import importlib.util
import os
import sys
import threading

# 中文 Windows 的控制台默认是 GBK，输出「✓」这类字符会抛 UnicodeEncodeError。
# 强制 stdout/stderr 用 UTF-8，这样无论从哪种终端启动都能正常打印。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "抢课助手.pyw")

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"  {'✓' if ok else '❌'} {name}" + (f"  —— {detail}" if detail else ""))


def load_app():
    spec = importlib.util.spec_from_file_location("grab_app_ui", APP)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class StubWorker(threading.Thread):
    """假 Worker：不碰浏览器，只记录有没有被启动。"""

    instances = []

    def __init__(self, ui_q, cmd_q, url, headless=False, profile_dir=None):
        super().__init__(daemon=True)
        self.ui_q = ui_q
        self.cmd_q = cmd_q
        self.url = url
        StubWorker.instances.append(self)

    def run(self):
        pass

    def quit(self):
        pass


def main():
    import tkinter as tk

    print("=" * 70)
    print("桌面版 UI 层测试")
    print("=" * 70)

    mod = load_app()
    mod.Worker = StubWorker          # 注入桩，避免真的开 Chrome
    StubWorker.instances.clear()

    try:
        root = tk.Tk()
    except Exception as e:
        print(f"无法创建 Tk 窗口（没有图形环境？）：{e}")
        return 1

    root.withdraw()                  # 测试时不显示窗口
    app = mod.App(root)

    # ---------- 1. 窗口与控件 ----------
    print("\n[1] 窗口与控件")
    check("窗口标题正确", root.title() == "🏸 抢课助手", root.title())
    check("主按钮是「开始抢课」", "开始抢课" in app.start_btn.cget("text"),
          app.start_btn.cget("text"))
    check("有停止按钮", "停止" in app.stop_btn.cget("text"))
    check("有注入脚本按钮", "注入" in app.inject_btn.cget("text"))
    check("结果卡片存在", app.result_card.winfo_exists() == 1)
    check("界面搭好后自动启动了工作线程", len(StubWorker.instances) == 1)

    # ---------- 2. 结果渲染 ----------
    print("\n[2] 结果大卡片各状态")
    cases = [
        ("ok",   "抢课成功", "羽毛球 / 李老师"),
        ("fail", "未抢到",   "目标课程已满员"),
        ("run",  "抢课中",   None),
        ("wait", "待命中",   None),
        ("idle", "未开始",   None),
    ]
    for state, want_main, want_sub in cases:
        app.render_result({
            "state": state, "course": "羽毛球", "teacher": "李老师",
            "detail": "服务器返回：选课成功" if state == "ok" else "目标课程已满员",
        })
        main_text = app.result_main.cget("text")
        sub_text = app.result_sub.cget("text")
        ok = want_main in main_text and (want_sub is None or want_sub in sub_text)
        check(f"{state} 状态渲染正确", ok, f"{main_text!r} / {sub_text!r}")

    # 成功后应显示课程名
    app.render_result({"state": "ok", "course": "羽毛球", "teacher": "李老师",
                       "detail": "服务器返回：选课成功"})
    check("成功时显示课程与老师",
          "羽毛球" in app.result_sub.cget("text") and "李老师" in app.result_sub.cget("text"),
          app.result_sub.cget("text").replace("\n", " | "))

    # 失败时应显示原因
    app.render_result({"state": "fail", "detail": "目标课程已满员（一直没等到空位）"})
    check("失败时显示原因", "已满员" in app.result_sub.cget("text"),
          app.result_sub.cget("text"))

    # ---------- 3. 点「开始抢课」投递的命令 ----------
    print("\n[3] 点「开始抢课」")
    app.kw_var.set("羽毛球")
    app.at_var.set("13:00:00")
    app.dry_var.set(False)

    cmds = []
    while not app.cmd_q.empty():
        cmds.append(app.cmd_q.get_nowait())

    app.on_start()

    cmds = []
    while not app.cmd_q.empty():
        cmds.append(app.cmd_q.get_nowait())
    kinds = [c[0] for c in cmds]

    check("投递了 setopts（同步窗口设置到页面）", "setopts" in kinds, str(kinds))
    check("投递了 start", "start" in kinds, str(kinds))

    setopts = next((c for c in cmds if c[0] == "setopts"), None)
    check("setopts 带上了关键词与准点时间",
          setopts == ("setopts", "羽毛球", "13:00:00", False), str(setopts))

    check("界面立刻切到「抢课中」", "抢课中" in app.result_main.cget("text"),
          app.result_main.cget("text"))

    # ---------- 4. 停止 / 注入 / 打开网址 ----------
    print("\n[4] 其它按钮")
    while not app.cmd_q.empty():
        app.cmd_q.get_nowait()
    app.on_stop()
    app.on_inject()
    app.on_goto()
    cmds = []
    while not app.cmd_q.empty():
        cmds.append(app.cmd_q.get_nowait())
    kinds = [c[0] for c in cmds]
    check("停止/注入/打开网址都投递了命令",
          kinds == ["stop", "inject", "goto"], str(kinds))

    # ---------- 5. 关闭 ----------
    print("\n[5] 关闭")
    try:
        app._on_close()
        check("关闭时不抛异常", True)
    except Exception as e:
        check("关闭时不抛异常", False, repr(e))

    print("\n" + "=" * 70)
    n_ok = sum(1 for r in results if r)
    print(f"UI 层结果：{n_ok}/{len(results)} 通过")
    print("=" * 70)
    return 0 if n_ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
