# -*- coding: utf-8 -*-
"""
上传前信息泄露审计
================================================================================
检查三个层面：
  1. 当前被 git 跟踪的文件里有没有敏感信息
  2. git 历史里「曾经」出现过哪些文件（删掉的文件在 git 里仍存在）
  3. git 所有对象（含历史版本）里有没有敏感字符串

用法：python _audit.py
"""
import io
import os
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)


def git(*args):
    r = subprocess.run(["git"] + list(args), capture_output=True)
    return r.stdout.decode("utf-8", "replace")


# 敏感信息特征
PATTERNS = [
    ("邮箱地址",        r"[\w.+-]+@[\w-]+\.[\w.]{2,}"),
    ("中国大陆手机号",   r"(?<!\d)1[3-9]\d{9}(?!\d)"),
    ("身份证号",        r"(?<!\d)\d{17}[\dXx](?!\d)"),
    ("Windows 用户路径", r"[A-Za-z]:\\+Users\\+[^\\\s\"']+"),
    ("其它盘符绝对路径",  r"(?<![\w])[A-Za-z]:\\+(?!Users)[\w\u4e00-\u9fff]"),
    ("本机用户名",       r"\bLENOVO\b"),
    ("IPv4 地址",       r"(?<![\d.])(?!127\.|0\.0\.0\.0|255\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])"),
    ("batchId 取值",    r"batchId=[^&\s\"'<>)]+"),
    ("疑似 token/key",  r"(?i)\b(api[_-]?key|secret|access[_-]?token|auth[_-]?token|bearer|password|passwd)\b\s*[:=]\s*\S+"),
    ("Cookie 名",       r"(?i)\b(JSESSIONID|ASP\.NET_SessionId|PHPSESSID|csrftoken|XSRF-TOKEN)\b"),
    ("私钥",            r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ("真实工号样式",      r"(?<![A-Za-z0-9])A\d{8,}(?![A-Za-z0-9])"),
]

# 明确允许的例外（示例值、占位符、公开域名）
WHITELIST = [
    "xk.dnui.edu.cn",              # 学校选课站域名（公开信息，且是项目必需）
    "www.dnui.edu.cn",
    "https://www.python.org",
    "https://www.tampermonkey.net",
    "https://github.com",
    "https://xk.dnui.edu.cn",      # 文档里的示例 URL
    "127.0.0.1",
    "255.255.255.0",
    "noreply",
    "example.com",
    "privaterelay.appleid.com",    # Apple 隐私转发地址（本身即匿名）
]

# batchId 是「学期+批次」的标识，真实的会是一串有意义的数字/编码。
# 下面这些是测试里写的占位值，不是真实 batchId。
FAKE_BATCHID = re.compile(r"^batchId=(t|test|TEST|\.\.\.|xxx+|0+|1+)$")

EXT = (".js", ".pyw", ".py", ".md", ".json", ".bat", ".txt", ".yml", ".yaml")


def scan_text(text, label, findings):
    # 跳过审计脚本自己 —— 它里面就写着这些检测用的正则，
    # 不排除的话会「自己举报自己」，产生一堆误报。
    if "privacy_check.py" in label:
        return
    for name, pat in PATTERNS:
        for m in re.finditer(pat, text):
            val = m.group(0)
            if any(w in val for w in WHITELIST):
                continue
            if FAKE_BATCHID.match(val):      # 测试里的假 batchId
                continue
            line_no = text[:m.start()].count("\n") + 1
            findings.append((label, name, val, line_no))


def main():
    problems = []

    # ---------------- 1. 当前跟踪的文件 ----------------
    print("=" * 72)
    print("① 当前被 git 跟踪的文件")
    print("=" * 72)
    tracked = [f for f in git("ls-files").splitlines() if f]
    print(f"跟踪文件数: {len(tracked)}\n")
    for f in tracked:
        if not f.lower().endswith(EXT):
            continue
        try:
            text = io.open(f, encoding="utf-8", errors="replace").read()
        except Exception:
            continue
        before = len(problems)
        scan_text(text, f, problems)
        for (file_, name, val, line_no) in problems[before:]:
            print(f"  [{name}] {file_}:{line_no}  ->  {val[:80]}")

    # ---------------- 2. git 历史里出现过的文件 ----------------
    print()
    print("=" * 72)
    print("② git 历史里曾经提交过的所有文件（含已删除的）")
    print("=" * 72)
    ever = set()
    for line in git("log", "--all", "--pretty=format:", "--name-only").splitlines():
        line = line.strip()
        if line:
            ever.add(line)
    risky_ever = sorted(
        p for p in ever
        if ".chrome-profile" in p or "node_modules" in p
        or "__pycache__" in p or "配置.json" in p
    )
    print(f"历史中出现过的文件总数: {len(ever)}")
    if risky_ever:
        print(f"  ❌ 历史里有敏感文件: {risky_ever[:20]}")
    else:
        print("  ✓ 历史里从未出现 .chrome-profile / node_modules / __pycache__ / 配置.json")

    # ---------------- 3. 历史所有版本的内容 ----------------
    print()
    print("=" * 72)
    print("③ 扫描 git 历史中每个版本的文件内容")
    print("=" * 72)
    hist_problems = []
    revs = [r for r in git("rev-list", "--all").splitlines() if r]
    print(f"提交数: {len(revs)}")
    for rev in revs:
        for f in git("ls-tree", "-r", "--name-only", rev).splitlines():
            if not f.lower().endswith(EXT):
                continue
            blob = git("show", f"{rev}:{f}")
            if not blob:
                continue
            scan_text(blob, f"{f} @ {rev[:7]}", hist_problems)
    if hist_problems:
        for (file_, name, val, line_no) in hist_problems[:30]:
            print(f"  [{name}] {file_}:{line_no}  ->  {val[:80]}")
    else:
        print("  ✓ 历史内容里没有发现敏感信息")

    # ---------------- 4. 提交作者信息 ----------------
    print()
    print("=" * 72)
    print("④ 每次提交里公开的作者信息（会显示在 GitHub 上）")
    print("=" * 72)
    authors = git("log", "--pretty=format:%an <%ae>").splitlines()
    for a in sorted(set(authors)):
        print(f"  {a}")

    # ---------------- 5. 未被跟踪但存在于磁盘的敏感目录 ----------------
    print()
    print("=" * 72)
    print("⑤ 磁盘上存在、但被 .gitignore 挡住的敏感目录")
    print("=" * 72)
    for d in (".chrome-profile", "node_modules", "__pycache__"):
        if os.path.exists(d):
            n = sum(len(files) for _, _, files in os.walk(d))
            ignored = git("check-ignore", d).strip()
            mark = "✓ 已忽略" if ignored else "❌ 未忽略！"
            print(f"  {mark}  {d}/  ({n} 个文件)")
        else:
            print(f"  (不存在)  {d}/")
    if os.path.exists("抢课助手配置.json"):
        ignored = git("check-ignore", "抢课助手配置.json").strip()
        print(f"  {'✓ 已忽略' if ignored else '❌ 未忽略！'}  抢课助手配置.json")

    # ---------------- 汇总 ----------------
    print()
    print("=" * 72)
    total = len(problems) + len(hist_problems) + len(risky_ever)
    if total == 0:
        print("结论：✓ 未发现信息泄露，可以安全上传")
    else:
        print(f"结论：❌ 发现 {total} 处问题，需要处理")
    print("=" * 72)
    return 0 if total == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
