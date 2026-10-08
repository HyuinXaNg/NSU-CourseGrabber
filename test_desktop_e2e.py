# -*- coding: utf-8 -*-
"""
桌面版端到端集成测试
================================================================================
真实网站（xk.dnui.edu.cn）这台机器连不上，所以造一个**本地假选课页**，
让桌面程序走完整条链路：

    Playwright 启动 Chrome → 打开假选课页 → 注入 grab_course.gui.js
    → setopts 同步设置 → start → 点「选择」→ 弹成功提示 → 读回 result()

两个场景：
    A. 正常：点「选择」后弹出「选课成功」  → 期望 result.state == 'ok'
    B. 失败：点「选择」后弹出「选课未成功」→ 期望 result.state != 'ok'（且不误判成功）

用法：python test_desktop_e2e.py
"""

import importlib.util
import os
import queue
import shutil
import sys
import tempfile
import time

# 中文 Windows 的控制台默认是 GBK，输出「✓」这类字符会抛 UnicodeEncodeError。
# 强制 stdout/stderr 用 UTF-8，这样无论从哪种终端启动都能正常打印。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "抢课助手.pyw")


def load_app_module():
    spec = importlib.util.spec_from_file_location("grab_app", APP)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def make_fake_page(msg, path):
    html = """<!doctype html><html><head><meta charset="utf-8"><title>假选课页</title></head><body>
  <div class="card">
    <div>[083-羽毛球][T9000001]李老师</div>
    <div>已选容量：0/67</div>
    <button id="pick">选择</button>
  </div>
  <script>
    document.getElementById('pick').addEventListener('click', function () {
      if (document.querySelector('.el-message')) return;
      var t = document.createElement('div');
      t.className = 'el-message';
      t.textContent = %s;
      document.body.appendChild(t);
    });
  </script>
</body></html>""" % ('"' + msg + '"')
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)


def run_case(name, toast_msg, expect_ok, profile):
    """跑一个场景，返回 (是否通过, 说明)"""
    ui_q = queue.Queue()
    cmd_q = queue.Queue()

    tmpdir = tempfile.mkdtemp(prefix="e2e_")
    page_file = os.path.join(tmpdir, "fake.html")
    make_fake_page(toast_msg, page_file)
    url = "file:///" + page_file.replace("\\", "/")

    app = load_app_module()
    w = app.Worker(ui_q, cmd_q, url, headless=True, profile_dir=profile)
    w.start()

    result = {}
    logs = []

    def drain(timeout_s):
        end = time.time() + timeout_s
        while time.time() < end:
            try:
                kind, payload = ui_q.get(timeout=0.2)
            except queue.Empty:
                continue
            if kind == "log":
                logs.append(payload)
            elif kind == "result" and payload:
                result.clear()
                result.update(payload)

    # 等浏览器起来并打开页面
    drain(6.0)

    # 注入 + 同步设置 + 开始
    cmd_q.put(("setopts", "羽毛球", "", False))
    cmd_q.put(("start",))
    drain(6.0)

    cmd_q.put(("quit",))
    time.sleep(0.5)

    state = result.get("state")
    detail = result.get("detail", "")
    course = result.get("course", "")
    shutil.rmtree(tmpdir, ignore_errors=True)

    ok = (state == "ok") if expect_ok else (state != "ok")
    print(f"  {'✓' if ok else '❌'} {name}")
    print(f"      result.state = {state!r}   course = {course!r}")
    print(f"      detail = {detail!r}")
    if not ok:
        print(f"      日志：{logs[-6:]}")
    return ok, state


def main():
    print("=" * 70)
    print("桌面版端到端集成测试（Playwright + 真实 Chrome + 本地假选课页）")
    print("=" * 70)

    if not os.path.exists(APP):
        print(f"找不到 {APP}")
        return 1

    profile = os.path.join(tempfile.gettempdir(), "e2e_chrome_profile")
    passed = []

    print("\n[A] 点「选择」后弹出「选课成功」 → 期望判为成功")
    ok_a, _ = run_case("正常场景", "选课成功", True, profile)
    passed.append(ok_a)

    print("\n[B] 点「选择」后弹出「选课未成功」 → 期望不判为成功")
    ok_b, _ = run_case("反向场景", "选课未成功，请稍后重试", False, profile)
    passed.append(ok_b)

    print("\n" + "=" * 70)
    n_ok = sum(1 for p in passed if p)
    print(f"端到端结果：{n_ok}/{len(passed)} 通过")
    print("=" * 70)
    return 0 if n_ok == len(passed) else 1


if __name__ == "__main__":
    sys.exit(main())
