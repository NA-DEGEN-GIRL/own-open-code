using System;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;

namespace OwnCuHelper
{
    // The helper's UI thread: a hidden top-level window that owns the stop chord (RegisterHotKey) and hears display
    // changes (WM_DISPLAYCHANGE is broadcast to top-level windows only), plus the on-screen indicator. Requests that need
    // a message queue (window.focus) or a window (indicator) run here through Invoke.
    internal static class Ui
    {
        const int HotKeyId = 1;

        static MessageWindow window;
        static Indicator indicator;
        static volatile bool hotKey;

        public static bool HotKeyRegistered
        {
            get { return hotKey; }
        }

        public static void Start()
        {
            var ready = new ManualResetEvent(false);
            var thread = new Thread(delegate()
            {
                window = new MessageWindow();
                hotKey = RegisterHotKey();
                ready.Set();
                Application.Run();
            });
            thread.IsBackground = true;
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            ready.WaitOne();
        }

        public static void Stop()
        {
            Run(delegate()
            {
                if (hotKey) Native.UnregisterHotKey(window.Handle, HotKeyId);
                if (indicator != null) indicator.Close();
                Application.ExitThread();
            });
        }

        // Another helper (a second service) may hold the chord until it exits; retried when this one takes the desktop.
        public static void EnsureHotKey()
        {
            if (!hotKey) Run(delegate() { hotKey = RegisterHotKey(); });
        }

        public static void Run(Action action)
        {
            Exception error = null;
            window.Invoke((MethodInvoker)delegate()
            {
                try
                {
                    action();
                }
                catch (Exception caught)
                {
                    error = caught;
                }
            });
            if (error != null) throw error;
        }

        public static void Indicate(bool on, string text)
        {
            Run(delegate()
            {
                if (!on)
                {
                    if (indicator != null) indicator.Hide();
                    return;
                }
                if (indicator == null || indicator.IsDisposed) indicator = new Indicator();
                indicator.ShowText(text);
            });
        }

        static bool RegisterHotKey()
        {
            return Native.RegisterHotKey(window.Handle, HotKeyId, Native.MOD_CONTROL | Native.MOD_ALT | Native.MOD_SHIFT | Native.MOD_NOREPEAT, Native.VK_Q);
        }

        sealed class MessageWindow : Form
        {
            public MessageWindow()
            {
                ShowInTaskbar = false;
                FormBorderStyle = FormBorderStyle.None;
                // Creates the (never shown) window on this thread.
                CreateHandle();
            }

            protected override void SetVisibleCore(bool value)
            {
                base.SetVisibleCore(false);
            }

            protected override void WndProc(ref Message message)
            {
                if (message.Msg == Native.WM_HOTKEY && message.WParam.ToInt32() == HotKeyId)
                {
                    // Let go of everything at once; the TS side engages its kill switch when the event arrives.
                    Input.ReleaseAll();
                    Program.Emit("kill_chord");
                }
                if (message.Msg == Native.WM_DISPLAYCHANGE) Program.Emit("display_changed");
                base.WndProc(ref message);
            }
        }

        // A click-through, never-activated banner at the top of the primary display, excluded from captures
        // (WDA_EXCLUDEFROMCAPTURE) so it never shows up in the model's screenshots.
        sealed class Indicator : Form
        {
            readonly Label label;

            public Indicator()
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                StartPosition = FormStartPosition.Manual;
                AutoScaleMode = AutoScaleMode.None;
                BackColor = Color.FromArgb(176, 32, 32);
                Opacity = 0.9;
                label = new Label { AutoSize = true, ForeColor = Color.White, Font = new Font("Segoe UI", 11f, FontStyle.Bold), Location = new Point(12, 6) };
                Controls.Add(label);
            }

            protected override bool ShowWithoutActivation
            {
                get { return true; }
            }

            protected override CreateParams CreateParams
            {
                get
                {
                    var value = base.CreateParams;
                    value.ExStyle |= Native.WS_EX_TOPMOST | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE | Native.WS_EX_TRANSPARENT | Native.WS_EX_LAYERED;
                    return value;
                }
            }

            protected override void OnHandleCreated(EventArgs e)
            {
                base.OnHandleCreated(e);
                Native.SetWindowDisplayAffinity(Handle, Native.WDA_EXCLUDEFROMCAPTURE);
            }

            public void ShowText(string text)
            {
                label.Text = string.IsNullOrEmpty(text) ? "에이전트가 이 PC를 조작하고 있습니다 · 중지: Ctrl+Alt+Shift+Q" : text;
                var size = label.PreferredSize;
                Size = new Size(size.Width + 24, size.Height + 12);
                var area = Screen.PrimaryScreen.Bounds;
                Location = new Point(area.X + (area.Width - Width) / 2, area.Y + 8);
                if (!Visible) Show();
            }
        }
    }
}
