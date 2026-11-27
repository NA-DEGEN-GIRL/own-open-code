# The real-desktop suite's only input target (test/real/desktop.test.ts), run by the system powershell.exe, so the suite
# compiles no exe of its own: a topmost borderless window with a TextBox, a password TextBox, a Button and a scrollable
# Panel on solid, known colours. It reports what it receives as JSON lines on stdout (ASCII, non-ASCII escaped) and
# exits when stdin closes. Per-Monitor-V2 aware, so every coordinate it reports is a physical pixel, like the drivers'.
# Arguments: <title> <x> <y>. Commands on stdin: "rects" (report the layout again), "clear" (empty the TextBox),
# "activate", "exit".
param([string] $Title, [int] $X, [int] $Y)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
# Two things PowerShell cannot express on its own: Per-Monitor-V2 awareness before the first window, and a message
# filter that sees every wheel message of the thread (WM_MOUSEWHEEL, WM_MOUSEHWHEEL) whichever control it is routed to.
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace OwnCuFixture
{
    public static class Dpi
    {
        [DllImport("user32.dll")]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    }

    public sealed class WheelFilter : IMessageFilter
    {
        public event Action<bool, int, IntPtr> Wheel;

        public bool PreFilterMessage(ref Message message)
        {
            if (message.Msg != 0x020A && message.Msg != 0x020E) return false;
            var handler = Wheel;
            if (handler != null) handler(message.Msg == 0x020A, (short)((message.WParam.ToInt64() >> 16) & 0xffff), message.HWnd);
            return false;
        }
    }
}
'@

[void][OwnCuFixture.Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$out.AutoFlush = $true
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))

function Emit([string] $json) {
    $out.Write($json + "`n")
}

function Str([string] $text) {
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    foreach ($c in $text.ToCharArray()) {
        $code = [int]$c
        if ($c -eq '"') { [void]$builder.Append('\"') }
        elseif ($c -eq '\') { [void]$builder.Append('\\') }
        elseif ($code -lt 0x20 -or $code -gt 0x7e) { [void]$builder.Append('\u').Append($code.ToString('x4')) }
        else { [void]$builder.Append($c) }
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Rect($rect) {
    return '{"x":' + $rect.X + ',"y":' + $rect.Y + ',"width":' + $rect.Width + ',"height":' + $rect.Height + '}'
}

function Bool([bool] $value) {
    if ($value) { return 'true' }
    return 'false'
}

$background = [System.Drawing.Color]::FromArgb(255, 0, 255)
$yellow = [System.Drawing.Color]::FromArgb(255, 255, 0)
$cyan = [System.Drawing.Color]::FromArgb(0, 255, 255)

[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Name = 'form'
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.KeyPreview = $true
$form.BackColor = $background
$form.Bounds = New-Object System.Drawing.Rectangle($X, $Y, 640, 440)

$text = New-Object System.Windows.Forms.TextBox
$text.Name = 'textbox'
$text.Location = New-Object System.Drawing.Point(20, 20)
$text.Width = 460
$text.Font = New-Object System.Drawing.Font('Segoe UI', 16)

# UI Automation reports IsPassword for it; the gate must never type into it.
$password = New-Object System.Windows.Forms.TextBox
$password.Name = 'password'
$password.Location = New-Object System.Drawing.Point(500, 20)
$password.Width = 120
$password.Font = New-Object System.Drawing.Font('Segoe UI', 16)
$password.UseSystemPasswordChar = $true

# No label and no hover or press colours: the whole client area stays one known colour in screenshots.
$button = New-Object System.Windows.Forms.Button
$button.Name = 'button'
$button.Location = New-Object System.Drawing.Point(20, 100)
$button.Size = New-Object System.Drawing.Size(220, 80)
$button.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$button.BackColor = $yellow
$button.FlatAppearance.MouseOverBackColor = $yellow
$button.FlatAppearance.MouseDownBackColor = $yellow

$panel = New-Object System.Windows.Forms.Panel
$panel.Name = 'panel'
$panel.Location = New-Object System.Drawing.Point(20, 200)
$panel.Size = New-Object System.Drawing.Size(460, 220)
$panel.AutoScroll = $true
$panel.BackColor = $cyan
$content = New-Object System.Windows.Forms.Panel
$content.Name = 'content'
$content.Location = New-Object System.Drawing.Point(0, 0)
$content.Size = New-Object System.Drawing.Size(400, 4000)
$content.BackColor = $cyan
$panel.Controls.Add($content)
$form.Controls.AddRange(@($text, $password, $button, $panel))

# Client rectangles in screen coordinates: mouse events report client coordinates of the control they hit.
function Report([string] $name) {
    $screens = ([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { '{"bounds":' + (Rect $_.Bounds) + ',"primary":' + (Bool $_.Primary) + '}' }) -join ','
    Emit ('{"event":' + (Str $name) +
        ',"hwnd":' + (Str ('0x' + $form.Handle.ToInt64().ToString('x'))) +
        ',"pid":' + $PID +
        ',"title":' + (Str $form.Text) +
        ',"window":' + (Rect $form.Bounds) +
        ',"textbox":' + (Rect $text.RectangleToScreen($text.ClientRectangle)) +
        ',"password":' + (Rect $password.RectangleToScreen($password.ClientRectangle)) +
        ',"button":' + (Rect $button.RectangleToScreen($button.ClientRectangle)) +
        ',"panel":' + (Rect $panel.RectangleToScreen($panel.ClientRectangle)) +
        ',"dpi":' + $form.DeviceDpi +
        ',"screens":[' + $screens + ']}')
}

$text.add_TextChanged({ Emit ('{"event":"text","text":' + (Str $text.Text) + '}') })
$text.add_GotFocus({ Emit '{"event":"focus","target":"textbox"}' })
# Only the length: what reaches a password field is never echoed.
$password.add_TextChanged({ Emit ('{"event":"password","length":' + $password.TextLength + '}') })
$password.add_GotFocus({ Emit '{"event":"focus","target":"password"}' })
foreach ($control in @($form, $text, $password, $button, $panel, $content)) {
    $control.add_MouseDown({
        param($source, $e)
        Emit ('{"event":"mouse","target":' + (Str $source.Name) + ',"button":' + (Str $e.Button.ToString().ToLowerInvariant()) + ',"x":' + $e.X + ',"y":' + $e.Y + '}')
    })
}
$button.add_MouseClick({
    param($source, $e)
    Emit ('{"event":"click","target":"button","x":' + $e.X + ',"y":' + $e.Y + '}')
})
# Ctrl+A selects all here like in most apps (a single-line TextBox does not do it by itself on every Windows).
$form.add_KeyDown({
    param($source, $e)
    Emit ('{"event":"key","vk":' + [int]$e.KeyCode + ',"ctrl":' + (Bool $e.Control) + ',"alt":' + (Bool $e.Alt) + ',"shift":' + (Bool $e.Shift) + '}')
    if ($e.Control -and $e.KeyCode -eq [System.Windows.Forms.Keys]::A) {
        $text.SelectAll()
        $e.SuppressKeyPress = $true
    }
})
$form.add_Activated({ Emit '{"event":"activated"}' })
$form.add_Deactivate({ Emit '{"event":"deactivated"}' })

$filter = New-Object OwnCuFixture.WheelFilter
$filter.add_Wheel({
    param($vertical, $delta, $hwnd)
    $control = [System.Windows.Forms.Control]::FromHandle($hwnd)
    $target = if ($null -eq $control) { '?' } else { $control.Name }
    $axis = if ($vertical) { 'v' } else { 'h' }
    Emit ('{"event":"wheel","axis":"' + $axis + '","delta":' + $delta + ',"target":' + (Str $target) + '}')
    $form.BeginInvoke([Action] { Emit ('{"event":"scrolled","value":' + $panel.VerticalScroll.Value + '}') }) | Out-Null
})
[System.Windows.Forms.Application]::AddMessageFilter($filter)

# stdin is read without blocking the UI thread: a timer polls one pending ReadLineAsync (scriptblocks cannot run on
# another thread in PowerShell).
$script:reading = $null
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 20
$timer.add_Tick({
    if ($null -eq $script:reading) { $script:reading = $stdin.ReadLineAsync() }
    if (-not $script:reading.IsCompleted) { return }
    $line = $script:reading.Result
    $script:reading = $null
    if ($null -eq $line -or $line.Trim() -eq 'exit') {
        $timer.Stop()
        $form.Close()
        return
    }
    switch ($line.Trim()) {
        'rects' { Report 'rects' }
        'clear' { $text.Text = '' }
        'activate' { $form.Activate() }
    }
})
$form.add_Shown({
    Report 'ready'
    $timer.Start()
})
[System.Windows.Forms.Application]::Run($form)
