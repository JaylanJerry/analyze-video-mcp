import { describe, expect, it } from "vitest";
import { redactKnownPaths, sanitizeSensitiveText } from "../src/sanitize.js";

const CANARY_KEY = "sk-demo-canary-abcdefghijklmnop";

describe("redactKnownPaths", () => {
  it("hides the exact supplied path even when it has spaces or non-ASCII letters", () => {
    const text = "模型说：文件 /tmp/剪辑 视频.mp4 与 /tmp/かな.mp4 都听不清";
    const out = redactKnownPaths(text, ["/tmp/剪辑 视频.mp4", "/tmp/かな.mp4"]);
    expect(out).not.toContain("剪辑 视频.mp4");
    expect(out).not.toContain("かな.mp4");
    expect(out).toBe("模型说：文件 [本地路径已隐藏] 与 [本地路径已隐藏] 都听不清");
  });

  it("matches slash-style and case variants of a Windows path", () => {
    const path = String.raw`C:\Users\张三\我的 视频.mp4`;
    for (const echoed of [
      path,
      "C:/Users/张三/我的 视频.mp4",
      String.raw`c:\users\张三\我的 视频.mp4`,
    ]) {
      const out = redactKnownPaths(`见 ${echoed} 处`, [path]);
      expect(out).not.toContain("我的 视频.mp4");
      expect(out).toContain("[本地路径已隐藏]");
    }
  });

  it("keeps a public link intact when the local path is a substring of it", () => {
    const text = "本地 /tmp/x.mp4 与公开 https://cdn.example/tmp/x.mp4 都提到了";
    const out = redactKnownPaths(text, ["/tmp/x.mp4"]);
    expect(out).toContain("https://cdn.example/tmp/x.mp4");
    expect(out).toContain("本地 [本地路径已隐藏]");
  });

  it("ends a public link at sentence punctuation followed by the supplied path", () => {
    const path = "/tmp/剪辑 视频.mp4";
    const link = "https://cdn.example/a.mp4";
    for (const punctuation of ["，", "。", "；", ",", ";", "."]) {
      const text = `参考 ${link}${punctuation}${path}`;
      const out = sanitizeSensitiveText(redactKnownPaths(text, [path]));
      expect(out).toBe(`参考 ${link}${punctuation}[本地路径已隐藏]`);
    }
    expect(redactKnownPaths("公开 https://cdn.example/a,b.mp4 可用", [path])).toBe(
      "公开 https://cdn.example/a,b.mp4 可用",
    );
  });

  it("still hides an internal oss link that contains the path", () => {
    const text = "地址 oss://bucket/tmp/x.mp4 与本地 /tmp/x.mp4";
    const out = sanitizeSensitiveText(redactKnownPaths(text, ["/tmp/x.mp4"]));
    expect(out).not.toContain("oss://");
    expect(out).not.toContain("/tmp/x.mp4");
    expect(out).toContain("[内部媒体地址已隐藏]");
    expect(out).toContain("[本地路径已隐藏]");
  });

  it("leaves URLs, time codes and unrelated text alone", () => {
    const text = "公开 https://cdn.example/a/b.mp4 与 00:30 处，画面/声音";
    expect(redactKnownPaths(text, ["C:/x/y.mp4"])).toBe(text);
  });
});

describe("sanitizeSensitiveText", () => {
  it("hides non-ASCII segments in a generic POSIX path", () => {
    const out = sanitizeSensitiveText("模型说：/tmp/かな.mp4 听不清");
    expect(out).not.toContain("かな.mp4");
    expect(out).toContain("[本地路径已隐藏]");
  });

  it("hides Windows paths in both slash styles and UNC paths", () => {
    for (const raw of [
      String.raw`C:\Users\demo\Videos\clip.mp4`,
      "C:/Users/demo/Videos/clip.mp4",
      String.raw`D:\media\片段.mov`,
      String.raw`\\server\share\clip.mp4`,
      "C:/Users/demo/no-extension",
    ]) {
      const out = sanitizeSensitiveText(`见 ${raw} 处`);
      expect(out).not.toContain(raw);
      expect(out).toContain("[本地路径已隐藏]");
    }
  });

  it("hides POSIX paths whose segments are non-ASCII", () => {
    for (const raw of [
      "/home/张三/视频.mp4",
      "/tmp/误时铺.mp4",
      "/视频.mp4",
      "/资料/视频/中文.mp4",
    ]) {
      const out = sanitizeSensitiveText(`见 ${raw} 处`);
      expect(out).not.toContain(raw);
      expect(out).toContain("[本地路径已隐藏]");
    }
  });

  it("keeps prose that merely uses a slash, and keeps URLs with non-ASCII paths", () => {
    const prose = "见 00:30 处，画面/声音与对白/旁白/音效";
    expect(sanitizeSensitiveText(prose)).toBe(prose);
    expect(sanitizeSensitiveText("公开 https://cdn.example/视频.mp4 可用")).toContain(
      "https://cdn.example/视频.mp4",
    );
  });

  it("hides a forward-slash UNC path and a bare root-level file", () => {
    for (const raw of [
      "//server/share/clip.mp4",
      "//fileserver/media/中文.mp4",
      "/clip.mp4",
      "/media.mov",
    ]) {
      const out = sanitizeSensitiveText(`见 ${raw} 处`);
      expect(out).not.toContain(raw);
      expect(out).toContain("[本地路径已隐藏]");
    }
  });

  it("hides POSIX absolute paths", () => {
    for (const raw of ["/tmp/demo.mp3", "/var/tmp/sample.mov", "/Users/demo/a.mp4", "/home/x/b"]) {
      const out = sanitizeSensitiveText(`media at ${raw} end`);
      expect(out).not.toContain(raw);
      expect(out).toContain("[本地路径已隐藏]");
    }
  });

  it("hides the internal upload location and credential-shaped tokens", () => {
    const out = sanitizeSensitiveText(
      `地址 oss://dashscope-tmp/abc/clip.mp4 与 key ${CANARY_KEY} 都出现`,
    );
    expect(out).not.toContain("oss://");
    expect(out).not.toContain(CANARY_KEY);
    expect(out).toContain("[内部媒体地址已隐藏]");
    expect(out).toContain("[凭证已隐藏]");
  });

  it("keeps public URLs, time codes and ordinary prose intact", () => {
    const text =
      "https://cdn.example/v.mp4 与 http://example.com:8080/a/b 在 00:30 处，画面是 24，声音读 3.1415926。";
    expect(sanitizeSensitiveText(text)).toBe(text);
  });

  it("keeps a relative file name and a bare slash pair intact", () => {
    expect(sanitizeSensitiveText("clip.mp4 与 a/b/c 以及 // 都应保留")).toBe(
      "clip.mp4 与 a/b/c 以及 // 都应保留",
    );
  });

  it("keeps a scheme-relative URL host intact while hiding a UNC path", () => {
    // Both start with `//`; only the one without a scheme is a path.
    expect(sanitizeSensitiveText("公开链接 https://cdn.example/a/b.mp4 可用")).toContain(
      "https://cdn.example/a/b.mp4",
    );
    expect(sanitizeSensitiveText("本机 //fileserver/media/clip.mp4 不可外发")).not.toContain(
      "fileserver",
    );
  });

  it("does not eat the URL path segments of a media link", () => {
    const out = sanitizeSensitiveText("远端是 https://cdn.example/videos/clip-2024.mp4 (公开)");
    expect(out).toContain("https://cdn.example/videos/clip-2024.mp4");
  });

  it("still hides a POSIX path that follows CJK punctuation", () => {
    const out = sanitizeSensitiveText("路径：/tmp/x.mp3，以及 /var/tmp/y.mov。");
    expect(out).not.toContain("/tmp/x.mp3");
    expect(out).not.toContain("/var/tmp/y.mov");
  });
});
