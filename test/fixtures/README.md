# Synthetic CI live fixture

Tiny generated clip: on-screen `24`, spoken `3.1415926`.
Used by GitHub Live Smoke when `QWEN_LIVE_VIDEO` is unset.
Not the personal `text/` fixture.

## Small sound truth set (2026-09-25)

These additional generated clips are for a small, controlled live comparison. They contain no private media or speech.

| File                                    | Independent sound truth                                                                                                     | What it can test                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `synthetic-music-tone.mp4`              | Three steady sine tones at 261.63, 329.63 and 392 Hz, mixed at low levels; no voice, lyrics, beat, or environmental sounds. | Recognition of a simple musical chord / music-like tone. This is **not** a song or singing sample. |
| `synthetic-silence-aac.mp4`             | 8 seconds of AAC stereo digital silence.                                                                                    | Avoiding sound claims when a valid audio track is silent.                                          |
| `synthetic-motion-silent-aac.mp4`       | A red rectangle moves across a gray field; audio is 8 seconds of AAC stereo digital silence.                                | Avoiding inferred action sound effects when visible motion has no matching sound.                  |
| `live-av.mp4`                           | Existing generated control: visible `24`, spoken `3.1415926`.                                                               | Clear speech recognition control only.                                                             |
| `synthetic-silence-tail-moov.mov`       | 2 seconds of stereo AAC digital silence; generated MOV with the `moov` atom at EOF.                                         | Container seeking behavior for FFmpeg stdin-pipe vs authorized FileHandle input.                   |
| `synthetic-multitrack-silence.mp4`      | Two duplicated stereo AAC tracks with digital-zero samples.                                                                 | Independent per-track statistics when every track is silent.                                       |
| `synthetic-multitrack-silence-tone.mp4` | One stereo AAC digital-zero track plus a second non-zero AAC tone track.                                                    | Per-track separation; the combined result must not classify all tracks as silent.                  |

The three added clips were generated locally with FFmpeg 8.1.1, using only lavfi sources and H.264/AAC encoding. Commands (run from repository root):

```powershell
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=black:s=320x180:r=12:d=8" -f lavfi -i "sine=frequency=261.63:sample_rate=44100:duration=8" -f lavfi -i "sine=frequency=329.63:sample_rate=44100:duration=8" -f lavfi -i "sine=frequency=392:sample_rate=44100:duration=8" -filter_complex "[1:a]volume=0.18[a1];[2:a]volume=0.12[a2];[3:a]volume=0.1[a3];[a1][a2][a3]amix=inputs=3:duration=longest[a]" -map 0:v -map "[a]" -c:v libx264 -preset veryslow -crf 32 -pix_fmt yuv420p -c:a aac -b:a 48k -shortest test/fixtures/synthetic-music-tone.mp4
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=gray:s=320x180:r=12:d=8" -f lavfi -i "anullsrc=r=44100:cl=stereo:d=8" -c:v libx264 -preset veryslow -crf 32 -pix_fmt yuv420p -c:a aac -b:a 48k -shortest test/fixtures/synthetic-silence-aac.mp4
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=gray:s=320x180:r=12:d=8" -f lavfi -i "anullsrc=r=44100:cl=stereo:d=8" -vf "drawbox=x='mod(t*100,320)':y=60:w=50:h=50:color=red:t=fill" -c:v libx264 -preset veryslow -crf 32 -pix_fmt yuv420p -c:a aac -b:a 48k -shortest test/fixtures/synthetic-motion-silent-aac.mp4
```

The tail-moov MOV used for input-identity experiments was also generated locally with FFmpeg 8.1.1; the default non-fragmented MOV mux order places `moov` after media data. Verify the actual atom order rather than relying on this assumption:

```powershell
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=gray:s=320x180:r=12:d=2" -f lavfi -i "anullsrc=r=44100:cl=stereo:d=2" -c:v libx264 -preset veryslow -crf 32 -pix_fmt yuv420p -c:a aac -b:a 48k -shortest test/fixtures/synthetic-silence-tail-moov.mov
node scripts/research/file-handle-audio-input.mjs
```

> **历史（2026-09-25 下一大版本）：** 以下关于可选 FFmpeg 数字静音测量的夹具与实验记录保留作证据；该测量、`src/audio-silence.ts` 与 `test/audio-silence.test.ts` 已从代码中移除，`QWEN_AUDIO_SILENCE_CHECK` 不再生效，`RUN_FFMPEG_FIXTURES=1` 也不再对应任何测试文件。`test/fixtures/synthetic-multitrack-*.mp4` 仍留在仓库中。

For the opt-in silence measurement, two additional multitrack fixtures were derived from the listed synthetic silence and tone inputs. The first duplicates the silent AAC track; the second retains one silent track and adds the non-zero tone track. Their independent truth is track-level digital zero/non-zero only; the tone is not evidence of music, song, or singing.

```powershell
ffmpeg -hide_banner -loglevel error -i test/fixtures/synthetic-silence-aac.mp4 -map 0:v:0 -map 0:a:0 -map 0:a:0 -c copy test/fixtures/synthetic-multitrack-silence.mp4 -y
ffmpeg -hide_banner -loglevel error -i test/fixtures/synthetic-silence-aac.mp4 -i test/fixtures/synthetic-music-tone.mp4 -map 0:v:0 -map 0:a:0 -map 1:a:0 -c:v copy -c:a copy -shortest test/fixtures/synthetic-multitrack-silence-tone.mp4 -y
```

The real local-only checks are opt-in and do not run in default `npm test`: set `RUN_FFMPEG_FIXTURES=1` for `test/audio-silence.test.ts`. They use one inherited authorized FileHandle fd per clip and verify `fd:` decoding, per-track output, tail-moov seek, and that the handle still reads at offset 0 afterwards. The implemented parser keys each stats line by its `astats` filter context, not by output order; any missing/duplicate context or missing samples/peak yields `incomplete`.

The experiment uses only these generated clips. It compares direct path open, FFmpeg `pipe:0` fed from an already-open Node `FileHandle`, the same regular file descriptor inherited as child stdin and opened with FFmpeg `fd:`, and a mode-0600 copy written from that handle then reopened by FFmpeg. It prints fixture names and aggregate decode/resource labels only, deletes its temporary directory on exit, and does not accept arbitrary paths. A recorded run on Windows Node 24 / FFmpeg 8.1.1 found `moov` at EOF for both MP4/MOV fixtures. `pipe:0`, inherited `fd:`, direct path and temp-copy decode were complete for all three fixtures. Thus these tested tail-moov MP4/MOV files work through both streaming stdin and a seekable inherited descriptor; coverage is too small to claim all MOV variants. The inherited-FD route completed in about 46–56 ms, versus 60–66 ms by path, 61–75 ms by pipe, and 60–65 ms for copy+decode on these tiny files. Temp copies occupied exactly the input size (4–56 KB). Parent RSS deltas were noisy and do not estimate peak or FFmpeg child RSS. Cancellation terminated and reaped the child for pipe, inherited-fd, and temp-copy paths; the authorized FileHandle remained readable from offset 0 after inherited-fd decode and cancellation, and temp files were deleted after the cancelled child closed. Node Windows mode `0o600` alone does not prove a restrictive Windows ACL, so the copy route still needs an ACL design.
