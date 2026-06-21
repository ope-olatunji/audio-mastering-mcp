import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/** Run ffmpeg, returning stderr (where ffmpeg writes logs + loudnorm JSON). */
async function ff(args: string[]): Promise<string> {
  try {
    const { stderr } = await pexec(FFMPEG, args, { maxBuffer: 96 * 1024 * 1024 });
    return stderr;
  } catch (e: unknown) {
    const err = e as { stderr?: string };
    if (err?.stderr) return err.stderr;
    throw e;
  }
}

/** Pull the last loudnorm print_format=json blob out of ffmpeg stderr. */
function lastLoudnormJson(stderr: string): Record<string, string> {
  const m = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g);
  if (!m) throw new Error("loudnorm JSON not found in ffmpeg output:\n" + stderr.slice(-600));
  return JSON.parse(m[m.length - 1]);
}

// --- the professional mastering chain (everything up to the limiter) ---
const PRE =
  "[0:a]aformat=sample_rates=44100:channel_layouts=stereo," +
  "highpass=f=28," + // sub rumble cleanup
  "equalizer=f=300:width_type=q:w=1.0:g=-2," + // tame low-mid mud
  "equalizer=f=3000:width_type=q:w=1.4:g=-1," + // tame harshness
  "bass=g=1.5:f=90:width_type=q:w=0.8," + // low-end warmth shelf
  "treble=g=2:f=11000:width_type=q:w=0.7," + // air shelf
  "acompressor=threshold=-16dB:ratio=2:attack=20:release=200:makeup=1.5[pre];" + // glue
  "[pre]acrossover=split=150 4000[low][mid][high];" + // 3-band split
  "[low]acompressor=threshold=-22dB:ratio=2.5:attack=10:release=180[lowc];" + // control sub/808
  "[mid]acompressor=threshold=-20dB:ratio=2:attack=15:release=160[midc];" + // glue mids
  "[high]acompressor=threshold=-24dB:ratio=2:attack=5:release=120[highc];" + // smooth highs
  "[lowc][midc][highc]amix=inputs=3:normalize=0[mb];" +
  "[mb]asoftclip=type=tanh," + // gentle saturation
  "aexciter=level_in=1:level_out=1:amount=2:freq=7000:blend=3[exc]"; // high-freq sheen

/** Stereo stage: 'immersive' keeps bass mono + widens highs + subtle air. */
function spatialStage(kind: string): string {
  if (kind === "none") return ";[exc]aformat=channel_layouts=stereo[wide]";
  if (kind === "subtle") return ";[exc]extrastereo=m=1.12[wide]";
  return (
    ";[exc]acrossover=split=150[sl][sh];" +
    "[sl]pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1[slm];" + // bass mono = solid low end
    "[sh]stereotools=mlev=1.0:slev=1.5[shw];" + // widen the highs
    "[slm][shw]amix=inputs=2:normalize=0[wmix];" +
    "[wmix]aecho=in_gain=0.95:out_gain=0.92:delays=15|25|35:decays=0.12|0.08|0.05[wide]" // subtle depth/air
  );
}

const POST = ";[wide]alimiter=level_in=3.0:level_out=1:limit=0.9:attack=4:release=55[master]";

export interface Loudness {
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
  thresholdDb: number;
}

export async function analyzeLoudness(input: string): Promise<Loudness> {
  const s = await ff(["-hide_banner", "-i", input, "-af", "loudnorm=print_format=json", "-f", "null", "-"]);
  const d = lastLoudnormJson(s);
  return { integratedLufs: +d.input_i, truePeakDb: +d.input_tp, lra: +d.input_lra, thresholdDb: +d.input_thresh };
}

export async function masterAudio(o: {
  input: string;
  output: string;
  targetLufs?: number;
  truePeak?: number;
  spatial?: string;
  bitrate?: string;
}) {
  const I = o.targetLufs ?? -10;
  const TP = o.truePeak ?? -1.5;
  const LRA = 11;
  const br = o.bitrate ?? "320k";
  const sp = o.spatial ?? "immersive";
  const CHAIN = PRE + spatialStage(sp) + POST;

  // pass 1: measure post-chain loudness
  const s1 = await ff([
    "-hide_banner", "-y", "-i", o.input,
    "-filter_complex", `${CHAIN};[master]loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json[out]`,
    "-map", "[out]", "-f", "null", "-",
  ]);
  const d = lastLoudnormJson(s1);

  // pass 2: apply chain + linear loudnorm to the exact target
  const ln2 =
    `[master]loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:measured_I=${d.input_i}:measured_TP=${d.input_tp}:` +
    `measured_LRA=${d.input_lra}:measured_thresh=${d.input_thresh}:offset=${d.target_offset}:linear=true[out]`;
  await ff([
    "-hide_banner", "-y", "-i", o.input,
    "-filter_complex", `${CHAIN};${ln2}`,
    "-map", "[out]", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", br, o.output,
  ]);

  const final = await analyzeLoudness(o.output);
  const ms = await ff([
    "-hide_banner", "-i", o.output,
    "-af", "pan=mono|c0=0.5*c0+0.5*c1,loudnorm=print_format=json", "-f", "null", "-",
  ]);
  const monoI = +lastLoudnormJson(ms).input_i;
  return {
    output: o.output,
    spatial: sp,
    targetLufs: I,
    final,
    monoSumLufs: monoI,
    monoDropDb: +(final.integratedLufs - monoI).toFixed(1),
  };
}

export async function mixVocalOverBeat(o: {
  beat: string;
  vocal: string;
  output: string;
  vocalDelayMs?: number;
  beatVolume?: number;
  vocalVolume?: number;
}) {
  const delay = o.vocalDelayMs ?? 1200;
  const bv = o.beatVolume ?? 0.3;
  const vv = o.vocalVolume ?? 1.9;
  const fc =
    `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${bv}[bd];` +
    `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${delay}|${delay},highpass=f=95,` +
    `equalizer=f=3300:width_type=q:w=1.3:g=3.5,acompressor=threshold=-22dB:ratio=4:attack=4:release=130,` +
    `aecho=0.8:0.85:45:0.08,volume=${vv}[vox];` +
    `[vox]asplit=2[voxm][voxsc];` +
    `[bd][voxsc]sidechaincompress=threshold=0.022:ratio=12:attack=4:release=240[beatd];` +
    `[beatd][voxm]amix=inputs=2:normalize=0:duration=longest:weights=1 1.4,volume=0.7[out]`;
  await ff([
    "-hide_banner", "-y", "-i", o.beat, "-i", o.vocal,
    "-filter_complex", fc, "-map", "[out]", "-ar", "44100", "-c:a", "pcm_s24le", o.output,
  ]);
  return { output: o.output, vocalDelayMs: delay, beatVolume: bv, vocalVolume: vv };
}

export async function exportDolby(o: {
  input: string;
  output: string;
  codec?: string;
  bitrate?: string;
  channels?: number;
}) {
  const codec = o.codec ?? "eac3";
  const br = o.bitrate ?? "384k";
  const ch = o.channels ?? 2;
  await ff([
    "-hide_banner", "-y", "-i", o.input,
    "-c:a", codec, "-b:a", br, "-ar", "48000", "-ac", String(ch), o.output,
  ]);
  const info = await ff(["-hide_banner", "-i", o.output, "-f", "null", "-"]);
  const stream = (info.split("\n").find((l) => /Audio:/.test(l)) || "").trim();
  return {
    output: o.output,
    codec,
    bitrate: br,
    channels: ch,
    stream,
    note: codec === "eac3" ? "Dolby Digital Plus (E-AC-3) — channel-based, not Atmos" : "Dolby Digital (AC-3)",
  };
}
