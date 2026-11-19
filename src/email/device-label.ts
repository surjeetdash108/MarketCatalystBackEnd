/** "Chrome on Mac", "Safari on iPhone"… from a User-Agent; "Unknown device" when unreadable. */
export function deviceLabel(ua: string | null | undefined): string {
  const s = String(ua ?? "");
  const browser = /Edg\//.test(s)
    ? "Edge"
    : /OPR\/|Opera/.test(s)
      ? "Opera"
      : /SamsungBrowser/.test(s)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS/.test(s)
          ? "Firefox"
          : /Chrome\/|CriOS/.test(s)
            ? "Chrome"
            : /Safari\//.test(s)
              ? "Safari"
              : null;
  const os = /iPhone/.test(s)
    ? "iPhone"
    : /iPad/.test(s)
      ? "iPad"
      : /Android/.test(s)
        ? "Android"
        : /CrOS/.test(s)
          ? "ChromeOS"
          : /Mac OS X|Macintosh/.test(s)
            ? "Mac"
            : /Windows/.test(s)
              ? "Windows"
              : /Linux/.test(s)
                ? "Linux"
                : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}
