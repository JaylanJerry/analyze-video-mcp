/**
 * Agent-visible answer redaction. This is the only text rewriting the media gateway
 * performs on a model answer: it removes internal upload locations, credential-shaped
 * tokens and local absolute paths. It never changes what the model said about the media.
 *
 * Two layers, in this order:
 *
 * 1. `redactKnownPaths` — the exact path strings the Agent passed for this call, in both
 *    slash styles (and lowercase for Windows). A model echoing the prompt's path is the
 *    realistic leak, and this layer is exact: it does not depend on guessing which
 *    characters a file name may contain (spaces, kana, punctuation all work).
 * 2. The generic rules below — a supplement for paths this call never saw. They cover
 *    Windows drive and UNC paths in both slash styles, forward-slash UNC, and POSIX
 *    paths with non-ASCII segments. A generic match cannot cross whitespace, so a path
 *    that was never supplied and contains a space may be only partially redacted.
 *    Public URLs, time codes and prose that merely uses a slash (`画面/声音`) stay intact.
 */
const PATH_SEGMENT = "[^\\s/<>\"'，。；！？|?*]";
const KNOWN_POSIX_ROOTS = "home|tmp|Users|var|mnt|private|Volumes|media|srv|opt|etc|root|data";

/** Slash-style (and, for Windows paths, case) variants a model may echo. */
export function pathVariants(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length < 3) {
    return [];
  }
  const forward = trimmed.replaceAll("\\", "/");
  const backward = trimmed.replaceAll("/", "\\");
  const variants = new Set([trimmed, forward, backward]);
  if (/^[A-Za-z]:/.test(trimmed) || trimmed.startsWith("\\\\") || forward.startsWith("//")) {
    for (const variant of [...variants]) {
      variants.add(variant.toLowerCase());
    }
  }
  return [...variants];
}

/** Public links are preserved, so the deterministic layer must not rewrite inside one. */
const PUBLIC_URL_SPAN = /\bhttps?:\/\/[^\s"'<>]+/gi;
const URL_PATH_SEPARATORS = new Set(["，", "。", "；", "！", "？", "、", ",", ";", ".", "!", "?"]);

function replaceInGaps(segment: string, variants: readonly string[]): string {
  let out = segment;
  for (const variant of variants) {
    if (out.includes(variant)) {
      out = out.split(variant).join("[本地路径已隐藏]");
    }
  }
  return out;
}

/**
 * Exact, deterministic redaction of the media paths supplied for this call. Applied
 * before the generic rules so characters a heuristic would have to enumerate (spaces,
 * kana, punctuation) are covered.
 *
 * Public `http(s)` spans are left untouched: a local path can be a substring of an
 * unrelated public link (local `/tmp/x.mp4` inside `https://cdn.example/tmp/x.mp4`).
 * A sentence separator followed immediately by a known path ends the public link;
 * the path then belongs to the replaceable gap, even when it contains spaces. An
 * `oss://` link needs no special case here because the generic rules hide the whole
 * token on the next pass.
 */
export function redactKnownPaths(text: string, knownPaths: readonly string[]): string {
  const variants = knownPaths
    .flatMap((raw) => pathVariants(raw))
    .filter((variant) => variant.length >= 3);
  if (variants.length === 0) {
    return text;
  }
  let out = "";
  let cursor = 0;
  const urlMatcher = new RegExp(PUBLIC_URL_SPAN);
  for (let match = urlMatcher.exec(text); match !== null; match = urlMatcher.exec(text)) {
    const start = match.index;
    let end = start + match[0].length;
    for (let index = start; index < end; index += 1) {
      if (
        URL_PATH_SEPARATORS.has(text[index] ?? "") &&
        variants.some((variant) => text.startsWith(variant, index + 1))
      ) {
        end = index;
        break;
      }
    }
    out += replaceInGaps(text.slice(cursor, start), variants);
    out += text.slice(start, end);
    cursor = end;
    urlMatcher.lastIndex = end;
  }
  return out + replaceInGaps(text.slice(cursor), variants);
}

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
