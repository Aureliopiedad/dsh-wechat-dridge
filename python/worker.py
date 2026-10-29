"""One process owns every WeChat UI operation. stdout is JSONL only.

UI snapshots are observations, not reliable server-side message IDs.
The Node owner persists baselines and inbox together before advancing them.
"""
import contextlib
import hashlib
import json
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
wx = None


def client():
    global wx
    if wx is None:
        from wxauto4 import WeChat
        wx = WeChat(resize=False, ads=False)
    return wx


def switch(chat):
    w = client()
    w.ChatWith(who=chat, exact=True)
    time.sleep(0.35)
    info = w.ChatInfo() or {}
    if info.get("chat_name") != chat:
        raise RuntimeError(f"聊天窗口不匹配，期望 {chat}，实际 {info.get('chat_name')}")
    return w, info


def snapshot(chat):
    w, info = switch(chat)
    kind = info.get("chat_type")
    if kind not in ("friend", "group") and chat != "文件传输助手":
        raise RuntimeError(f"不支持或无法识别的聊天类型: {kind}")
    rows, counts = [], {}
    for m in w.GetAllMessage() or []:
        typ = str(getattr(m, "type", ""))
        if typ != "text":
            continue
        sender = str(getattr(m, "sender", "") or "")
        content = str(getattr(m, "content", "") or "")
        attr = str(getattr(m, "attr", "") or "")
        # UI id may change on window reconstruction; prefer library hash when present.
        stable = str(getattr(m, "hash", "") or "")
        base = json.dumps([chat, sender, typ, content, attr, stable], ensure_ascii=False)
        counts[base] = counts.get(base, 0) + 1
        ident = hashlib.sha256((base + str(counts[base])).encode()).hexdigest()
        rows.append({"id": ident, "chat": chat, "kind": "group" if kind == "group" else "private",
                     "sender": sender, "content": content, "type": typ,
                     "self": attr == "self", "observedAt": int(time.time() * 1000)})
    return rows


def operate(method, p):
    if method == "status":
        w = client()
        return {"ready": True, "account": w.GetMyInfo()}
    if method == "snapshot":
        return snapshot(p["chat"])
    if method == "send":
        w, _ = switch(p["chat"])
        if p.get("file"):
            label = w.SendMsg(msg=p["content"] + "\n以下文件由 AI 发送", who=p["chat"], clear=True, exact=True)
            if not isinstance(label, dict) or label.get("status") != "成功":
                raise RuntimeError(f"AI 文件标注发送失败: {label}")
            result = w.SendFiles(filepath=p["file"], who=p["chat"], exact=True)
        else:
            result = w.SendMsg(msg=p["content"], who=p["chat"], clear=True, exact=True)
        if not isinstance(result, dict) or result.get("status") != "成功":
            raise RuntimeError(f"微信未确认操作成功: {result}")
        return {"status": "submitted", "detail": str(result), "deliveryConfirmed": False}
    raise ValueError(f"未知操作: {method}")


if __name__ == "__main__":
    for line in sys.stdin:
        req = {}
        try:
            req = json.loads(line)
            # Dependencies sometimes print diagnostics; preserve stdio framing.
            with contextlib.redirect_stdout(sys.stderr):
                result = operate(req["method"], req.get("params", {}))
            response = {"id": req["id"], "result": result}
        except Exception as e:
            response = {"id": req.get("id"), "error": str(e)}
        print(json.dumps(response, ensure_ascii=False, default=str), flush=True)
