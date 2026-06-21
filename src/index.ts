#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyzeLoudness, masterAudio, mixVocalOverBeat, exportDolby } from "./master.js";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const server = new McpServer({ name: "audio-mastering", version: "1.0.0" });

server.tool(
  "analyze_loudness",
  "Measure a track's integrated loudness (LUFS), true peak (dBTP), loudness range (LRA) and gating threshold. Call before/after mastering to verify levels against a target (hip-hop ~-9 to -10 LUFS, streaming -14, ceiling -1 dBTP).",
  { input: z.string().describe("absolute path to an audio file") },
  async ({ input }) => json(await analyzeLoudness(input)),
);

server.tool(
  "master_audio",
  "Run a full professional mastering chain (corrective EQ -> glue compression -> 3-band multiband compression -> saturation -> harmonic exciter -> stereo stage -> driven limiter) with 2-pass loudnorm to hit an exact loudness/true-peak target. Outputs a 320kbps MP3. The 'spatial' option sets the stereo image: 'immersive' keeps the bass mono for a solid low end while widening the highs and adding subtle air for a bigger, more premium feel; 'subtle' adds light width; 'none' leaves the image as-is.",
  {
    input: z.string().describe("absolute path to the pre-master (mix) audio"),
    output: z.string().describe("absolute path for the mastered .mp3"),
    targetLufs: z.number().default(-10).describe("integrated loudness target in LUFS"),
    truePeak: z.number().default(-1.5).describe("true-peak ceiling in dBTP (use ~-1.5 so MP3 encoding stays under -1.0)"),
    spatial: z.enum(["none", "subtle", "immersive"]).default("immersive"),
    bitrate: z.string().default("320k"),
  },
  async (a) => json(await masterAudio(a)),
);

server.tool(
  "mix_vocal_over_beat",
  "Mix a vocal over an instrumental with sidechain ducking (the beat dips under the vocal so words cut through), plus presence EQ + light reverb on the voice and the beat pulled underneath. Outputs a 24-bit WAV pre-master that you then feed to master_audio.",
  {
    beat: z.string().describe("absolute path to the instrumental"),
    vocal: z.string().describe("absolute path to the vocal"),
    output: z.string().describe("absolute path for the .wav pre-master"),
    vocalDelayMs: z.number().default(1200).describe("how long the beat plays before the vocal enters"),
    beatVolume: z.number().default(0.3).describe("beat level under the vocal (lower = vocal more forward)"),
    vocalVolume: z.number().default(1.9),
  },
  async (a) => json(await mixVocalOverBeat(a)),
);

server.tool(
  "export_dolby",
  "Encode a track to a Dolby codec: 'eac3' = Dolby Digital Plus (E-AC-3), 'ac3' = Dolby Digital. IMPORTANT: these are channel-based Dolby codecs (the 'Dolby' badge), NOT object-based Dolby Atmos, and for a stereo music single give no sonic benefit over a good stereo master. True Atmos requires Dolby's Renderer (e.g. Logic Pro) and the separate stems. Default stereo at 48kHz; set channels=6 for a basic 5.1 upmix.",
  {
    input: z.string().describe("absolute path to the mastered stereo file"),
    output: z.string().describe("output path, e.g. track.eac3 or track.mp4"),
    codec: z.enum(["eac3", "ac3"]).default("eac3"),
    bitrate: z.string().default("384k"),
    channels: z.number().default(2).describe("2 = stereo; 6 = basic 5.1 upmix"),
  },
  async (a) => json(await exportDolby(a)),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[audio-mastering-mcp] ready (requires ffmpeg on PATH)");
}

main().catch((err) => {
  console.error(`[audio-mastering-mcp] ${(err as Error).message}`);
  process.exit(1);
});
