import { describe, expect, it } from "vitest";
import { sanitizeSensitiveText } from "../src/sanitize.js";

const CANARY_KEY = "sk-demo-canary-abcdefghijklmnop";

describe("sanitizeSensitiveText", () => {
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
