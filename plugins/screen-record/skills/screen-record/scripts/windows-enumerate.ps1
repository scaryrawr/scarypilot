$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public sealed class ScreenRecordWindow
{
    public string hwnd { get; set; }
    public uint processId { get; set; }
    public string processStartTime { get; set; }
    public uint threadId { get; set; }
    public string className { get; set; }
    public string title { get; set; }
    public string processName { get; set; }
    public int clientWidth { get; set; }
    public int clientHeight { get; set; }
    public int windowLeft { get; set; }
    public int windowTop { get; set; }
    public int windowWidth { get; set; }
    public int windowHeight { get; set; }
    public bool foreground { get; set; }
}

public sealed class ScreenRecordWindowList
{
    public ScreenRecordWindow[] windows { get; set; }
    public int uninspectableCount { get; set; }
}

public static class ScreenRecordWindowApi
{
    private const uint DwmwaCloaked = 14;
    private delegate bool EnumWindowsCallback(IntPtr hwnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLengthW(IntPtr hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetClassNameW(IntPtr hwnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetClientRect(IntPtr hwnd, out Rect rect);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attribute, out int value, int size);

    private static bool TryGetCloaked(IntPtr hwnd, out bool cloaked)
    {
        int value;
        var result = DwmGetWindowAttribute(hwnd, DwmwaCloaked, out value, Marshal.SizeOf(typeof(int)));
        cloaked = result == 0 && value != 0;
        return result == 0;
    }

    public static ScreenRecordWindowList Enumerate()
    {
        var windows = new List<ScreenRecordWindow>();
        var uninspectableCount = 0;
        var foreground = GetForegroundWindow();
        Exception callbackError = null;
        EnumWindowsCallback callback = (hwnd, lParam) =>
        {
            try
            {
                if (!IsWindowVisible(hwnd) || IsIconic(hwnd))
                    return true;

                bool cloaked;
                if (!TryGetCloaked(hwnd, out cloaked))
                {
                    uninspectableCount++;
                    return true;
                }
                if (cloaked)
                    return true;

                var titleLength = GetWindowTextLengthW(hwnd);
                if (titleLength <= 0)
                    return true;

                var title = new StringBuilder(Math.Min(titleLength, 1024) + 1);
                if (GetWindowTextW(hwnd, title, title.Capacity) <= 0)
                    return true;

                var className = new StringBuilder(256);
                if (GetClassNameW(hwnd, className, className.Capacity) <= 0)
                {
                    uninspectableCount++;
                    return true;
                }

                var classNameValue = className.ToString();
                if (classNameValue == "Progman" || classNameValue == "WorkerW")
                    return true;

                Rect clientRect;
                if (!GetClientRect(hwnd, out clientRect))
                {
                    uninspectableCount++;
                    return true;
                }

                Rect windowRect;
                if (!GetWindowRect(hwnd, out windowRect))
                {
                    uninspectableCount++;
                    return true;
                }

                var width = clientRect.Right - clientRect.Left;
                var height = clientRect.Bottom - clientRect.Top;
                var windowWidth = windowRect.Right - windowRect.Left;
                var windowHeight = windowRect.Bottom - windowRect.Top;
                if (width <= 0 || height <= 0 || windowWidth <= 0 || windowHeight <= 0)
                    return true;

                uint processId;
                var threadId = GetWindowThreadProcessId(hwnd, out processId);
                if (processId == 0 || threadId == 0 || processId > int.MaxValue)
                {
                    uninspectableCount++;
                    return true;
                }

                try
                {
                    using (var process = Process.GetProcessById((int)processId))
                    {
                        var processName = process.ProcessName;
                        var startTime = process.StartTime.ToUniversalTime().ToFileTimeUtc()
                            .ToString(CultureInfo.InvariantCulture);

                        if (String.IsNullOrWhiteSpace(processName))
                        {
                            uninspectableCount++;
                            return true;
                        }

                        windows.Add(new ScreenRecordWindow
                        {
                            hwnd = "0x" + hwnd.ToInt64().ToString("X", CultureInfo.InvariantCulture),
                            processId = processId,
                            processStartTime = startTime,
                            threadId = threadId,
                            className = classNameValue,
                            title = title.ToString(),
                            processName = processName,
                            clientWidth = width,
                            clientHeight = height,
                            windowLeft = windowRect.Left,
                            windowTop = windowRect.Top,
                            windowWidth = windowWidth,
                            windowHeight = windowHeight,
                            foreground = hwnd == foreground
                        });
                    }
                }
                catch (ArgumentException)
                {
                    uninspectableCount++;
                }
                catch (InvalidOperationException)
                {
                    uninspectableCount++;
                }
                catch (Win32Exception)
                {
                    uninspectableCount++;
                }
            }
            catch (Exception error)
            {
                callbackError = error;
                return false;
            }

            return true;
        };

        var enumerated = EnumWindows(callback, IntPtr.Zero);
        if (callbackError != null)
            throw new InvalidOperationException("Could not inspect a top-level Windows window.", callbackError);
        if (!enumerated)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not enumerate Windows top-level windows.");

        return new ScreenRecordWindowList
        {
            windows = windows.ToArray(),
            uninspectableCount = uninspectableCount
        };
    }
}
'@

[ScreenRecordWindowApi]::Enumerate() | ConvertTo-Json -Depth 4 -Compress
