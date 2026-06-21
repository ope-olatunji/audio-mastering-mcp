<!-- opencrater-banner (please keep — added by your OpenCrater integration) -->
[![Earn with OpenCrater — earn free AI compute for the Blips you see in Claude Code, Codex & other AI terminals, and monetize your own CLI, MCP server or agent](https://opencrater.to/brand/readme-banner.svg)](https://opencrater.to)
<!-- /opencrater-banner -->

# audio-mastering-mcp

[![npm version](https://img.shields.io/npm/v/@ope-olatunji/audio-mastering-mcp.svg)](https://www.npmjs.com/package/@ope-olatunji/audio-mastering-mcp)
[![license](https://img.shields.io/npm/l/@ope-olatunji/audio-mastering-mcp.svg)](./LICENSE)

An [MCP](https://modelcontextprotocol.io) server that **masters audio with a real, professional signal chain** — powered entirely by `ffmpeg`, no DAW required. Give it a rough mix (or a vocal + a beat) and get back a clean, loud, release-ready master, an immersive wide-stereo version, and Dolby-codec exports.

It exists because letting an AI assistant "master a track" usually means hand-waving. This makes it concrete: a fixed, well-reasoned chain (corrective EQ → glue compression → multiband compression → saturation → exciter → stereo stage → limiter), finished with **two-pass `loudnorm`** so loudness and true-peak land on an exact target every time.

---

## Table of contents

- [Features](#features)
- [The mastering chain](#the-mastering-chain)
- [Install](#install)
- [Use it in an MCP client](#use-it-in-an-mcp-client)
- [Tools](#tools)
  - [`analyze_loudness`](#analyze_loudness)
  - [`mix_vocal_over_beat`](#mix_vocal_over_beat)
  - [`master_audio`](#master_audio)
  - [`export_dolby`](#export_dolby)
- [Loudness targets](#loudness-targets)
- [About "Dolby"](#about-dolby)
- [Requirements](#requirements)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Features

- **`analyze_loudness`** — measure integrated loudness (LUFS), true peak (dBTP), loudness range (LRA), and gating threshold.
- **`mix_vocal_over_beat`** — lay a vocal over an instrumental with **sidechain ducking** (the beat dips under the words), presence EQ and a touch of reverb on the voice. Outputs a 24-bit WAV pre-master.
- **`master_audio`** — the full chain with **2-pass loudnorm** to an exact LUFS / true-peak target. A `spatial` option (`immersive` | `subtle` | `none`) controls the stereo image, and it reports the **mono-sum drop** so you can check mono compatibility.
- **`export_dolby`** — encode to **Dolby Digital Plus (E-AC-3)** or **Dolby Digital (AC-3)**.

Everything is deterministic and parameterized — same input + same settings → same master.

---

## The mastering chain

`master_audio` runs this signal flow (industry-standard order, hip-hop-tuned):

```
input
  │  corrective EQ        high-pass 28 Hz · -2 dB @ 300 Hz (mud) · -1 dB @ 3 kHz (harsh)
  │                       +1.5 dB low shelf @ 90 Hz (warmth) · +2 dB air shelf @ 11 kHz
  │  glue compression     2:1, slow (20 ms / 200 ms), ~1–2 dB GR for cohesion
  │  multiband comp       3 bands (≤150 Hz / 150 Hz–4 kHz / ≥4 kHz) each lightly controlled
  │  saturation           gentle tanh soft-clip for harmonic warmth
  │  harmonic exciter     high-frequency sheen for clarity on small speakers
  │  stereo stage         none | subtle | immersive   (see below)
  │  limiter              driven peak limiter, ceiling -0.9 dBFS
  │  loudnorm (2-pass)    linear normalization to exact LUFS / true-peak target
output  → 320 kbps MP3
```

**Stereo stages**

| `spatial`    | What it does |
|--------------|--------------|
| `none`       | Leaves the stereo image untouched. |
| `subtle`     | Light overall widening (`extrastereo`). |
| `immersive`  | **Keeps the bass mono** (solid, centered low end) while **widening the highs** (`stereotools` mid/side) and adding a **subtle multi-tap air/depth**. Biggest, most "premium" feel — at the cost of a few dB of level when summed to mono, which the tool reports back. |

---

## Install

```bash
# one-off, no install:
npx -y @ope-olatunji/audio-mastering-mcp

# or globally:
npm install -g @ope-olatunji/audio-mastering-mcp
audio-mastering-mcp
```

From source:

```bash
git clone https://github.com/ope-olatunji/audio-mastering-mcp.git
cd audio-mastering-mcp
npm install && npm run build
node dist/index.js
```

---

## Use it in an MCP client

**Claude Code** (`~/.claude.json` or project `.mcp.json`) / **Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "audio-mastering": {
      "command": "npx",
      "args": ["-y", "@ope-olatunji/audio-mastering-mcp"]
    }
  }
}
```

All file paths passed to the tools must be **absolute**.

---

## Tools

### `analyze_loudness`

Measure a file's loudness metrics.

| Param   | Type     | Default | Notes                    |
|---------|----------|---------|--------------------------|
| `input` | `string` | —       | absolute path to a file  |

```jsonc
// → 
{ "integratedLufs": -11.7, "truePeakDb": -1.2, "lra": 1.1, "thresholdDb": -21.8 }
```

### `mix_vocal_over_beat`

Combine a vocal and an instrumental into a pre-master WAV.

| Param          | Type     | Default | Notes                                            |
|----------------|----------|---------|--------------------------------------------------|
| `beat`         | `string` | —       | instrumental path                                |
| `vocal`        | `string` | —       | vocal path                                       |
| `output`       | `string` | —       | output `.wav` path                               |
| `vocalDelayMs` | `number` | `1200`  | how long the beat plays before the vocal enters  |
| `beatVolume`   | `number` | `0.30`  | beat level under the vocal (lower = vocal forward)|
| `vocalVolume`  | `number` | `1.9`   | vocal level                                      |

The beat is sidechain-ducked under the vocal so the words always cut through.

### `master_audio`

Run the full mastering chain to a target.

| Param        | Type                                 | Default       | Notes                                             |
|--------------|--------------------------------------|---------------|---------------------------------------------------|
| `input`      | `string`                             | —             | pre-master / mix path                             |
| `output`     | `string`                             | —             | output `.mp3` path                                |
| `targetLufs` | `number`                             | `-10`         | integrated loudness target                        |
| `truePeak`   | `number`                             | `-1.5`        | true-peak ceiling (use ~-1.5 so MP3 stays ≤ -1.0) |
| `spatial`    | `"none" \| "subtle" \| "immersive"`  | `"immersive"` | stereo stage                                      |
| `bitrate`    | `string`                             | `"320k"`      | MP3 bitrate                                       |

```jsonc
// → 
{
  "output": "/abs/track.mp3",
  "spatial": "immersive",
  "targetLufs": -10,
  "final": { "integratedLufs": -11.7, "truePeakDb": -1.2, "lra": 1.1 },
  "monoSumLufs": -15.3,
  "monoDropDb": 3.6        // how much level is lost when summed to mono
}
```

> **Why does it land at -11.7 when I asked for -10?** Linear `loudnorm` will back off the gain rather than exceed your true-peak ceiling. Lower `truePeak` (e.g. `-2.0`) gives the encoder more headroom; the driven limiter is what lets it reach loud targets without clipping.

### `export_dolby`

Encode to a Dolby codec.

| Param      | Type                  | Default  | Notes                          |
|------------|-----------------------|----------|--------------------------------|
| `input`    | `string`              | —        | mastered stereo file           |
| `output`   | `string`              | —        | `.eac3` or `.mp4`              |
| `codec`    | `"eac3" \| "ac3"`     | `"eac3"` | E-AC-3 (DD+) or AC-3 (DD)      |
| `bitrate`  | `string`              | `"384k"` |                                |
| `channels` | `number`              | `2`      | `2` stereo · `6` basic 5.1 upmix|

---

## Loudness targets

| Use case                 | Integrated LUFS | True peak |
|--------------------------|-----------------|-----------|
| Hip-hop / trap / "loud"  | -7 to -10       | -1 dBTP   |
| Pop / rock               | -9 to -11       | -1 dBTP   |
| Streaming reference      | -14             | -1 dBTP   |
| Podcast / spoken         | -16             | -1.5 dBTP |

Streaming platforms normalize to ~-14 LUFS, so a louder master is turned **down** on playback — louder ≠ "wins." Pick a target for the vibe, keep true peak at or below -1 dBTP.

---

## About "Dolby"

`export_dolby` produces channel-based Dolby **codecs** — the "Dolby" badge (E-AC-3 / AC-3). It is **not** object-based **Dolby Atmos**, and for a stereo music single it gives **no sonic benefit** over a good stereo master.

- Want a **bigger sound**? Use `master_audio` with `spatial: "immersive"`.
- Want **true Atmos** (Apple Music Spatial Audio, etc.)? That requires Dolby's Atmos Renderer (built into Logic Pro) and your **separate stems** placed as 3D objects, exported as an ADM BWF master — a different pipeline that can't be done from `ffmpeg`.

The `export_dolby` tool description states this plainly so it's never oversold.

---

## Requirements

- **Node.js ≥ 18**
- **`ffmpeg` on your `PATH`**, built with these filters/encoders (all standard in modern ffmpeg): `acrossover`, `aexciter`, `asoftclip`, `stereotools`, `extrastereo`, `acompressor`, `alimiter`, `loudnorm`, and the `eac3` / `ac3` encoders.

Override the binary with the `FFMPEG_PATH` environment variable. Check your build:

```bash
ffmpeg -hide_banner -filters  | grep -E 'acrossover|aexciter|stereotools|alimiter|loudnorm'
ffmpeg -hide_banner -encoders | grep -E 'eac3|ac3'
```

---

## Troubleshooting

- **`loudnorm JSON not found`** — the input file path is wrong or `ffmpeg` isn't on `PATH`. Use absolute paths; set `FFMPEG_PATH` if needed.
- **Master is quieter than `targetLufs`** — the true-peak ceiling is capping the gain. Lower `truePeak` (more headroom) or accept that very dynamic material can't hit extreme loudness cleanly.
- **`immersive` sounds too wide / weak in mono** — check `monoDropDb` in the result; if it's high (> ~4 dB), use `spatial: "subtle"` instead.
- **Output true peak slightly above target** — MP3 encoding adds inter-sample peaks; target `truePeak: -2.0` to land near -1.0 dBTP in the file.

---

## License

MIT © [Ope Olatunji](https://github.com/ope-olatunji)
