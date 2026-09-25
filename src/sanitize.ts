/**
 * Agent-visible answer redaction. This is the only text rewriting the media
 * gateway performs on a model answer: it removes internal upload locations,
 * credential-shaped tokens and local absolute paths. It never changes what the
 * model said about the media.
 *
 * Path shapes covered: Windows drive paths and UNC paths in both slash styles,
 * forward-slash UNC (`//server/share/...`), and POSIX absolute paths — including
 * non-ASCII (CJK) directory and file names, which is why path segments allow
 * ideographs. Ordinary URLs (`https://host/a/b`) must survive, so a match may not
 * start after a URL-ish character (`:`, `/`, `.`, `-`, or an alphanumeric), and
 * prose that merely uses a slash (`画面/声音`) must not be mistaken for a path:
 * a path needs a known POSIX root or a file extension.
 */
const PATH_SEGMENT = "[A-Za-z0-9._\\-\\u4e00-\\u9fff]";
const KNOWN_POSIX_ROOTS = "home|tmp|Users|var|mnt|private|Volumes|media|srv|opt|etc|root|data";

export function sanitizeSensitiveText(text: string): string {
  return (
    text
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
      // Forward-slash UNC: two slashes, a host and at least one segment. A URL's `//`
      // is preceded by `:` and is therefore excluded by the lookbehind.
      .replace(
        new RegExp(`(?<![A-Za-z0-9:/._-])//${PATH_SEGMENT}+(?:/${PATH_SEGMENT}+)+`, "g"),
        "[本地路径已隐藏]",
      )
      // POSIX path under a standard root, whatever the leaf is called.
      .replace(
        new RegExp(`(?<![A-Za-z0-9:/._-])/(?:${KNOWN_POSIX_ROOTS})(?:/${PATH_SEGMENT}+)+`, "g"),
        "[本地路径已隐藏]",
      )
      // Any other multi-segment POSIX path, recognised by its file extension.
      .replace(
        new RegExp(
          `(?<![A-Za-z0-9:/._-])(?:/${PATH_SEGMENT}+)+/${PATH_SEGMENT}*\\.[A-Za-z0-9]{1,8}(?=$|[\\s，。；！？<>"'])`,
          "g",
        ),
        "[本地路径已隐藏]",
      )
      // A root-level file, also recognised by its extension.
      .replace(
        new RegExp(
          `(?<![A-Za-z0-9:/._-])/(?!/)${PATH_SEGMENT}+\\.[A-Za-z0-9]{1,8}(?=$|[\\s，。；！？<>"'])`,
          "g",
        ),
        "[本地路径已隐藏]",
      )
  );
}
