/**
 * Agent-visible answer redaction. This is the only text rewriting the media
 * gateway performs on a model answer: it removes internal upload locations,
 * credential-shaped tokens and local absolute paths. It never changes what the
 * model said about the media.
 *
 * Path shapes covered: Windows drive paths and UNC paths in both slash styles,
 * forward-slash UNC (`//server/share/...`), and POSIX absolute paths with one or
 * more segments. Ordinary URLs (`https://host/a/b`) must survive, which is why a
 * match may not start after a URL-ish character (`:`, `/`, `.`, `-`, or an
 * alphanumeric), and why a root-level POSIX path needs a file extension.
 */
export function sanitizeSensitiveText(text: string): string {
  return text
    .replace(/\boss:\/\/[^\s"'<>]+/gi, "[内部媒体地址已隐藏]")
    .replace(
      /\b(?:sk-(?:ws-|proj-|live-|test-)?[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~-]{12,})\b/gi,
      "[凭证已隐藏]",
    )
    .replace(
      /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)[^\r\n<>"'，。；！？|?*]*?\.[A-Za-z0-9]{1,8}(?=$|[\s，。；！？<>"'])/gi,
      "[本地路径已隐藏]",
    )
    .replace(
      /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)[^\s\r\n<>"'，。；！？|?*]+/g,
      "[本地路径已隐藏]",
    )
    .replace(
      /(?<![A-Za-z0-9:/._-])\/{1,2}(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g,
      "[本地路径已隐藏]",
    )
    .replace(
      /(?<![A-Za-z0-9:/._-])\/(?!\/)[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8}(?=$|[\s，。；！？<>"'])/g,
      "[本地路径已隐藏]",
    );
}
