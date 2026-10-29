using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Threading;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

class Worker
{
    static JavaScriptSerializer json = new JavaScriptSerializer();
    static Dictionary<string, List<Dictionary<string, object>>> snapshots = new Dictionary<string, List<Dictionary<string, object>>>();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int command);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr process);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint source, uint target, bool attach);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [STAThread]
    static void Main() {
        Console.InputEncoding = new System.Text.UTF8Encoding(false);
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        string line;
        while ((line = Console.ReadLine()) != null) {
            object id = null;
            try {
                var request = json.Deserialize<Dictionary<string, object>>(line);
                id = request["id"];
                var p = (Dictionary<string, object>)request["params"];
                object result;
                string method = (string)request["method"];
                if (method == "status") result = new {ready = true, backend = "csharp-uia", senderIdentification = false};
                else if (method == "snapshot") result = Snapshot((string)p["chat"]);
                else if (method == "send") result = Send(p);
                else throw new Exception("Unknown method: " + method);
                Console.WriteLine(json.Serialize(new {id = id, result = result}));
            } catch (Exception e) { Console.WriteLine(json.Serialize(new {id = id, error = e.Message})); }
        }
    }
    static AutomationElement Window(string chat) {
        var windows = AutomationElement.RootElement.FindAll(TreeScope.Children,
            new PropertyCondition(AutomationElement.NameProperty, chat));
        AutomationElement found = null;
        foreach (AutomationElement w in windows) {
            if (w.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ClassNameProperty, "mmui::MessageView")) == null) continue;
            if (found != null) throw new Exception("Ambiguous chat window: " + chat);
            found = w;
        }
        if (found == null) throw new Exception("Open the exact conversation as a separate window: " + chat);
        return found;
    }
    static List<Dictionary<string, object>> Snapshot(string chat) {
        var view = Window(chat).FindFirst(TreeScope.Descendants,
            new PropertyCondition(AutomationElement.ClassNameProperty, "mmui::MessageView"));
        var list = view.FindFirst(TreeScope.Descendants,
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.List));
        if (list == null) throw new Exception("Message list unavailable");
        var texts = new List<string>();
        var walker = TreeWalker.ControlViewWalker;
        var item = walker.GetLastChild(list);
        for (int i = 0; item != null && i < 80; i++, item = walker.GetPreviousSibling(item)) {
            var c = item.Current;
            if (c.ControlType == ControlType.ListItem && !String.IsNullOrEmpty(c.AutomationId)
                && c.ClassName == "mmui::ChatTextItemView" && !String.IsNullOrWhiteSpace(c.Name)) texts.Add(c.Name);
        }
        texts.Reverse();
        List<Dictionary<string, object>> old;
        if (!snapshots.TryGetValue(chat, out old)) old = new List<Dictionary<string, object>>();
        if (texts.Count == 0 && old.Count > 0) return old;
        int start = texts.Count; bool aligned = false;
        for (int length = Math.Min(old.Count, texts.Count); length > 0 && !aligned; length--) {
            for (int offset = texts.Count - length; offset >= 0; offset--) {
                bool equal = true;
                for (int j = 0; j < length; j++)
                    if ((string)old[old.Count - length + j]["content"] != texts[offset + j]) { equal = false; break; }
                if (equal) {start = offset + length; aligned = true; break;}
            }
        }
        // Retain stable observations, append only confirmed additions. On loss
        // of overlap return a fresh baseline tagged for the Node owner.
        var rows = aligned ? new List<Dictionary<string, object>>(old) : new List<Dictionary<string, object>>();
        if (!aligned) start = 0;
        for (int i = start; i < texts.Count; i++) rows.Add(new Dictionary<string, object> {
            {"id", Guid.NewGuid().ToString("N")}, {"chat", chat}, {"kind", "private"},
            {"sender", "unknown"}, {"senderKnown", false}, {"content", texts[i]}, {"type", "text"},
            {"self", false}, {"observedAt", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()},
            {"baselineOnly", !aligned}
        });
        // baselineOnly applies only to this observation, not future appends.
        if (rows.Count > 160) rows.RemoveRange(0, rows.Count - 160);
        snapshots[chat] = rows;
        return rows;
    }
    static object Send(Dictionary<string, object> p) {
        var window = Window((string)p["chat"]);
        var input = window.FindFirst(TreeScope.Descendants,
            new PropertyCondition(AutomationElement.ClassNameProperty, "mmui::ChatInputField"));
        if (input == null) throw new Exception("Chat input not found");
        string file = p.ContainsKey("file") ? p["file"] as string : null;
        if (file != null && !System.IO.File.Exists(file)) throw new Exception("File not found");
        var handle = new IntPtr(window.Current.NativeWindowHandle);
        Activate(handle);
        if (GetForegroundWindow() != handle) throw new Exception("Target chat lost focus");
        input.SetFocus();
        string content = (string)p["content"];
        // Enforce an AI marker at the final transport boundary as well.
        if (!System.Text.RegularExpressions.Regex.IsMatch(content, @"^【AI回复(?:｜[^】\r\n]+)?】\r?\n"))
            content = "【AI回复】\n" + content;
        Clipboard.SetText(content + (file == null ? "" : "\n以下文件由 AI 发送"));
        SendKeys.SendWait("^a"); SendKeys.SendWait("^v"); Thread.Sleep(100);
        if (GetForegroundWindow() != handle) throw new Exception("Target chat lost focus before send");
        SendKeys.SendWait("{ENTER}");
        if (file != null) {
            Thread.Sleep(300); input.SetFocus();
            if (GetForegroundWindow() != handle) throw new Exception("Target chat lost focus before file paste");
            var files = new StringCollection(); files.Add(System.IO.Path.GetFullPath(file));
            Clipboard.SetFileDropList(files); SendKeys.SendWait("^v"); Thread.Sleep(800);
            if (GetForegroundWindow() != handle) throw new Exception("Target chat lost focus before file send");
            SendKeys.SendWait("{ENTER}");
        }
        return new {status = "submitted", deliveryConfirmed = false, detail = "UI paste/Enter issued; inspect WeChat for delivery"};
    }

    static void Activate(IntPtr handle) {
        if (handle == IntPtr.Zero) throw new Exception("Target chat has no native window handle");
        if (GetForegroundWindow() == handle) return;
        ShowWindow(handle, 9);
        // A false API return is not proof of failure; check the actual foreground.
        SetForegroundWindow(handle);
        Thread.Sleep(120);
        if (GetForegroundWindow() == handle) return;
        uint current = GetCurrentThreadId();
        uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
        uint target = GetWindowThreadProcessId(handle, IntPtr.Zero);
        bool attachedForeground = false, attachedTarget = false;
        try {
            if (foreground != 0 && foreground != current)
                attachedForeground = AttachThreadInput(current, foreground, true);
            if (target != 0 && target != current && target != foreground)
                attachedTarget = AttachThreadInput(current, target, true);
            BringWindowToTop(handle);
            SetForegroundWindow(handle);
        } finally {
            if (attachedTarget) AttachThreadInput(current, target, false);
            if (attachedForeground) AttachThreadInput(current, foreground, false);
        }
        Thread.Sleep(150);
        if (GetForegroundWindow() != handle)
            throw new Exception("Windows denied chat activation. Manually activate the target conversation, then retry with a NEW request_id; no message was sent by this attempt.");
    }
}
