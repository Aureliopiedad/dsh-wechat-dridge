"""Read-only compatibility probe. Stop the bridge before running this script."""
import argparse
import ctypes
import importlib.metadata
import platform
import sys
import traceback


def main():
    parser = argparse.ArgumentParser(description="wxauto4 / 微信兼容性诊断（不发送消息）")
    parser.add_argument("--chat", help="可选：切换到精确备注名；读取会标记已读")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    print("目标微信版本：4.1.15.56（用户提供，未自动检测）")
    print("Python:", sys.version.split()[0], platform.architecture()[0])
    print("解释器:", sys.executable)
    if sys.platform != "win32":
        print("FAIL: 此 demo 需要 Windows")
        return 1
    print("管理员:", bool(ctypes.windll.shell32.IsUserAnAdmin()))
    try:
        print("wxauto4:", importlib.metadata.version("wxauto4"))
        from wxauto4 import WeChat
    except Exception:
        print("FAIL: 导入 wxauto4")
        traceback.print_exc()
        return 1

    # Enumerate visible top-level windows independently of wxauto4.
    user32 = ctypes.windll.user32
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    user32.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
    user32.GetClassNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
    user32.IsWindowVisible.argtypes = [ctypes.c_void_p]
    user32.EnumWindows.argtypes = [callback_type, ctypes.c_void_p]
    def visit(hwnd, _):
        title, cls = ctypes.create_unicode_buffer(512), ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, title, 512)
        user32.GetClassNameW(hwnd, cls, 256)
        if user32.IsWindowVisible(hwnd) and any(s in (title.value + cls.value).lower() for s in ["微信", "wechat", "weixin"]):
            print(f"窗口: title={title.value!r}, class={cls.value!r}")
        return True
    print("\nWindows 可见微信窗口：")
    user32.EnumWindows(callback_type(visit), None)

    stage = "初始化 WeChat(resize=False, ads=False)"
    try:
        print("\n检查:", stage)
        wx = WeChat(resize=False, ads=False)
        print("PASS: 主窗口初始化")
        stage = "GetMyInfo"
        account = wx.GetMyInfo()
        print("PASS: GetMyInfo，返回类型:", type(account).__name__)
        if args.chat:
            stage = "ChatWith"
            wx.ChatWith(who=args.chat, exact=True)
            import time
            time.sleep(0.35)
        stage = "ChatInfo"
        info = wx.ChatInfo() or {}
        print("聊天信息:", info)
        if args.chat and info.get("chat_name") != args.chat:
            raise RuntimeError("聊天名称不匹配")
        stage = "GetAllMessage"
        rows = wx.GetAllMessage() or []
        print("PASS: 读取当前可见消息，数量:", len(rows))
        print("消息类型:", sorted({str(getattr(m, "type", "")) for m in rows}))
        print("\n基础读取验证通过；没有验证发送、长时间监听和完整兼容性。")
        return 0
    except Exception:
        print(f"\nFAIL: {stage}")
        traceback.print_exc()
        print("此结果表示当前环境下该步骤失败，不能单独据此判定版本不兼容。")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
