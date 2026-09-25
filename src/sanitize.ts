/**
 * Agent-visible answer redaction. This is the only text rewriting the new media
 * gateway performs on a model answer: it removes internal upload locations,
 * credential-shaped tokens and local absolute paths. It never changes what the
 * model said about the media.
 */
export function sanitizeSensitiveText(text: string): string {
  return text
    .replace(/\boss:\/\/[^\s"'<>]+/gi, "[内部媒体地址已隐藏]")
    .replace(
      /\b(?:sk-(?:ws-|proj-|live-|test-)?[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~-]{12,})\b/gi,
      "[凭证已隐藏]",
    )
    .replace(
      /(?:[A-Za-z]:\\|\\\\)[^\r\n<>"'，。；！？|?*]*?\.[A-Za-z0-9]{1,8}(?=$|[\s，。；！？<>"'])/gi,
      "[本地路径已隐藏]",
    )
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s\r\n<>"'，。；！？|?*]+/g, "[本地路径已隐藏]")
    .replace(
      /(?<![A-Za-z0-9:/.])\/(?:Users|home|mnt|private|Volumes)\/[^\s<>"']+/g,
      "[本地路径已隐藏]",
    );
}
