using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace OwnCuHelper
{
    // Foreground input with SendInput. Every key and button this helper presses is tracked until released, so release.all,
    // the stop chord and stdin EOF can let go of everything; the lock keeps those releases from interleaving with a
    // request on the main thread.
    internal static class Input
    {
        static readonly object Gate = new object();
        static readonly HashSet<int> Keys = new HashSet<int>();
        static readonly HashSet<string> Buttons = new HashSet<string>();

        public static void Move(int x, int y)
        {
            lock (Gate)
            {
                Screens.RequireInput();
                if (!Native.SetCursorPos(x, y)) throw new RequestException("failed", "SetCursorPos failed (" + Marshal.GetLastWin32Error() + ")");
            }
        }

        public static void Button(string button, string action)
        {
            var flag = ButtonFlag(button, action);
            lock (Gate)
            {
                Screens.RequireInput();
                Send(new[] { Mouse(flag, 0) });
                if (action == "down") Buttons.Add(button);
                if (action == "up") Buttons.Remove(button);
            }
        }

        // Notches: positive dy scrolls up (away from the user), positive dx scrolls right.
        public static void Wheel(int dx, int dy)
        {
            var inputs = new List<Native.INPUT>();
            if (dy != 0) inputs.Add(Mouse(Native.MOUSEEVENTF_WHEEL, dy * Native.WHEEL_DELTA));
            if (dx != 0) inputs.Add(Mouse(Native.MOUSEEVENTF_HWHEEL, dx * Native.WHEEL_DELTA));
            if (inputs.Count == 0) return;
            lock (Gate)
            {
                Screens.RequireInput();
                Send(inputs.ToArray());
            }
        }

        public static void Key(int vk, bool extended, string action)
        {
            var up = action == "up";
            lock (Gate)
            {
                Screens.RequireInput();
                Send(new[] { Keyboard(vk, extended, up) });
                if (up) Keys.Remove(KeyId(vk, extended));
                if (!up) Keys.Add(KeyId(vk, extended));
            }
        }

        // KEYEVENTF_UNICODE: each UTF-16 unit becomes a VK_PACKET press, so neither the keyboard layout nor an IME
        // (Korean composition) changes what arrives. One SendInput call, so user input cannot interleave mid-text.
        public static void Text(string text)
        {
            var inputs = new Native.INPUT[text.Length * 2];
            for (var index = 0; index < text.Length; index++)
            {
                inputs[index * 2] = Unicode(text[index], false);
                inputs[index * 2 + 1] = Unicode(text[index], true);
            }
            if (inputs.Length == 0) return;
            lock (Gate)
            {
                Screens.RequireInput();
                Send(inputs);
            }
        }

        // Never fails: releasing is best effort and must not stop the other releases.
        public static void ReleaseAll()
        {
            lock (Gate)
            {
                var inputs = new List<Native.INPUT>();
                foreach (var key in Keys) inputs.Add(Keyboard(key & 0xff, (key & 0x100) != 0, true));
                foreach (var button in Buttons) inputs.Add(Mouse(ButtonFlag(button, "up"), 0));
                Keys.Clear();
                Buttons.Clear();
                if (inputs.Count > 0) Native.SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(Native.INPUT)));
            }
        }

        static int KeyId(int vk, bool extended)
        {
            return vk | (extended ? 0x100 : 0);
        }

        // SendInput reports how many events it inserted; UIPI (an elevated foreground window) drops input silently.
        static void Send(Native.INPUT[] inputs)
        {
            var sent = Native.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Native.INPUT)));
            if (sent != inputs.Length)
                throw new RequestException("failed", "SendInput inserted " + sent + " of " + inputs.Length + " events (" + Marshal.GetLastWin32Error() + ")");
        }

        static uint ButtonFlag(string button, string action)
        {
            var down = action == "down";
            if (button == "left") return down ? Native.MOUSEEVENTF_LEFTDOWN : Native.MOUSEEVENTF_LEFTUP;
            if (button == "right") return down ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_RIGHTUP;
            return down ? Native.MOUSEEVENTF_MIDDLEDOWN : Native.MOUSEEVENTF_MIDDLEUP;
        }

        static Native.INPUT Mouse(uint flags, int data)
        {
            var input = new Native.INPUT { type = Native.INPUT_MOUSE };
            input.u.mi = new Native.MOUSEINPUT { dwFlags = flags, mouseData = data };
            return input;
        }

        static Native.INPUT Keyboard(int vk, bool extended, bool up)
        {
            var input = new Native.INPUT { type = Native.INPUT_KEYBOARD };
            input.u.ki = new Native.KEYBDINPUT
            {
                wVk = (ushort)vk,
                wScan = (ushort)Native.MapVirtualKey((uint)vk, Native.MAPVK_VK_TO_VSC),
                dwFlags = (extended ? Native.KEYEVENTF_EXTENDEDKEY : 0) | (up ? Native.KEYEVENTF_KEYUP : 0),
            };
            return input;
        }

        static Native.INPUT Unicode(char unit, bool up)
        {
            var input = new Native.INPUT { type = Native.INPUT_KEYBOARD };
            input.u.ki = new Native.KEYBDINPUT { wScan = unit, dwFlags = Native.KEYEVENTF_UNICODE | (up ? Native.KEYEVENTF_KEYUP : 0) };
            return input;
        }
    }
}
