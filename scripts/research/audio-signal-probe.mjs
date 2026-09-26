#!/usr/bin/env node
// Non-production experiment. Probes only the repository's generated fixture set.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = resolve(repoRoot, "test/fixtures");
const fixtureNames = [
  "synthetic-silence-aac.mp4",
  "synthetic-motion-silent-aac.mp4",
  "synthetic-music-tone.mp4",
  "live-av.mp4",
];
const timeout = 30_000;
const maxBuffer = 64 * 1024;
const childEnv = Object.fromEntries(
  ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "PATHEXT"].flatMap((key) =>
    typeof process.env[key] === "string" ? [[key, process.env[key]]] : [],
  ),
);

function run(executable, args) {
  try {
    return spawnSync(executable, args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: childEnv,
      maxBuffer,
      shell: false,
      timeout,
      windowsHide: true,
    });
  } catch (error) {
    return { error };
  }
}

function oneLine(value) {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim() : undefined;
}

const ffmpegVersion = oneLine(run("ffmpeg", ["-version"]).stdout?.split("\n")[0]);
const ffprobeVersion = oneLine(run("ffprobe", ["-version"]).stdout?.split("\n")[0]);
if (ffmpegVersion === undefined || ffprobeVersion === undefined) {
  process.stderr.write("Research probe requires ffmpeg and ffprobe on PATH.\n");
  process.exit(2);
}

for (const fixtureName of fixtureNames) {
  const input = resolve(fixtureRoot, fixtureName);
  const probe = run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a",
    "-show_entries",
    "stream=index,codec_name,sample_rate,channels,duration",
    "-of",
    "json",
    input,
  ]);
  const streams =
    probe.status === 0 && typeof probe.stdout === "string"
      ? JSON.parse(probe.stdout).streams
      : undefined;
  const audioStreams = Array.isArray(streams) ? streams : undefined;

  if (audioStreams === undefined) {
    process.stdout.write(
      `${JSON.stringify({
        fixture: fixtureName,
        ffmpeg_version: ffmpegVersion,
        ffprobe_version: ffprobeVersion,
        audio_track_present: "unknown",
        decode_status: "incomplete",
        digital_silence: "unknown",
        reason: probe.error?.code ?? (probe.signal === "SIGTERM" ? "timeout" : "probe_failed"),
      })}\n`,
    );
    continue;
  }

  if (audioStreams.length === 0) {
    process.stdout.write(
      `${JSON.stringify({
        fixture: fixtureName,
        ffmpeg_version: ffmpegVersion,
        ffprobe_version: ffprobeVersion,
        audio_track_present: false,
        decode_status: "not_applicable",
        digital_silence: "unknown",
      })}\n`,
    );
    continue;
  }

  const trackResults = audioStreams.map((_, audioIndex) => {
    const decoded = run("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-v",
      "info",
      "-xerror",
      "-i",
      input,
      "-map",
      `0:a:${audioIndex}`,
      "-af",
      "astats=metadata=0:reset=0:measure_perchannel=none:measure_overall=Peak_level+RMS_level+Number_of_samples",
      "-f",
      "null",
      process.platform === "win32" ? "NUL" : "/dev/null",
    ]);
    const stderr = typeof decoded.stderr === "string" ? decoded.stderr : "";
    const sampleCount = Number(stderr.match(/Number of samples:\s*(\d+)/)?.[1]);
    const peakDbfs = stderr.match(/Peak level dB:\s*(\S+)/)?.[1];
    const rmsDbfs = stderr.match(/RMS level dB:\s*(\S+)/)?.[1];
    const complete =
      decoded.status === 0 &&
      Number.isSafeInteger(sampleCount) &&
      sampleCount > 0 &&
      peakDbfs !== undefined &&
      rmsDbfs !== undefined;

    return {
      audio_stream_ordinal: audioIndex,
      decode_status: complete ? "complete" : "incomplete",
      decoded_samples_per_channel: complete ? sampleCount : undefined,
      peak_dbfs: complete ? peakDbfs : undefined,
      rms_dbfs: complete ? rmsDbfs : undefined,
      exact_digital_silence: complete ? peakDbfs === "-inf" : "unknown",
      reason: complete ? undefined : (decoded.error?.code ?? "decode_or_stats_incomplete"),
    };
  });
  const complete = trackResults.every((track) => track.decode_status === "complete");
  const exactSilence =
    complete && trackResults.every((track) => track.exact_digital_silence === true);

  process.stdout.write(
    `${JSON.stringify({
      fixture: fixtureName,
      ffmpeg_version: ffmpegVersion,
      ffprobe_version: ffprobeVersion,
      audio_track_present: true,
      decode_status: complete ? "complete" : "incomplete",
      tracks: trackResults,
      exact_digital_silence: complete ? exactSilence : "unknown",
    })}\n`,
  );
}
