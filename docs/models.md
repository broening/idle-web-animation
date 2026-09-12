# Which model for which job

Prices read live from fal.ai `get_pricing` on 29.08.2026. Reverify before
quoting — they move.

**Read the `unit` field, not just the number.** Two traps, and rows below are
marked **?** or **T** where they apply:

- **? placeholder.** `google/nano-banana-lite/edit` reports
  `unit_price: 1, unit: "units"`. That is not one dollar per image, it is a
  value nobody filled in. Do not build a cost model on it.
- **T runtime unknown.** A price per `compute second` cannot be compared with
  one per `image` until the runtime is measured. Every T figure in this file
  is an **estimate**, not a measurement, and is labelled as such where it is
  used.

This project has six jobs, not one. The first sweep only looked for job 1 and
searched the word "segmentation", which found the wrong family of models
entirely.

---

## Job 1 — Layerize: one flat PNG into transparent parts

The core of the tool. These models do in one call what a mask plus an
inpainting pass does in eleven, and they return transparent layers, so what
sits behind an arm is already reconstructed.

| Model | Provider | Price | Notes |
|---|---|---|---|
| `bytedance/seedream/v5/pro/layerize` | fal | **T** $0.00017 / compute second | `prompt` names which elements to separate, and accepts `<bbox>left top right bottom</bbox>` for precise targeting. Returns base image + up to 16 layers ordered by z_index. **Best fit on capability** — the only one that takes the rig plan as its prompt. **Not established as cheapest:** against kie's $0.0375 flat it only wins below **220 compute seconds**, and nobody has measured the runtime. |
| `seedream/5-pro-layer-decomposition` | kie | $0.0375 / image | Same model, flat price instead of runtime. Also returns per-layer name, bbox and description. |
| `fal-ai/qwen-image-layered` | fal | $0.05 / image | `num_layers` is explicit (default 4) and it has a **`seed`**, so a run is repeatable. No prompt steering. |

**Tested 29.08.2026 on the priest.** Input `figures/priest/source.png`,
1000x1000, prompt naming six parts.

| | seedream layerize | qwen-image-layered | kie decomposition |
|---|---|---|---|
| parts returned | **6, exactly the ones asked for** | 6 images, one of them empty, one the whole figure | job failed |
| per-layer name | yes | no | - |
| bounding box | yes, absolute pixels | no | - |
| z order | yes | no | - |
| resolution | kept 1000x1000 | downscaled to 640x640 | - |
| reconstruction | colour distance 9.2/255, nothing uncovered, 6.5 % double-covered | 5.5/255, but only because one layer is the whole figure | - |

**Winner: `bytedance/seedream/v5/pro/layerize`, and not close.** It returned
"Belly and lower jacket", "Arm", "Chest and shoulders including white clerical
collar", "Head with hair and round glasses", "Open eyes" and "Hand holding the
wooden stake" — each transparent, each with a box, in stacking order. That
metadata is worth as much as the pixels: it maps straight onto `figure.json`.

Qwen decomposed almost nothing and tells you nothing about what it did return.
Its `seed` is still the only reproducibility any of them offers.

### kie.ai cannot fetch images from Western hosts

The kie job failed before the model ran, and a second test settled why.

| Source given to kie | What kie's server reported |
|---|---|
| `v3b.fal.media` (fal's CDN) | TLS verification failed — the certificate it got names `cd8ukg94e1omtfb44s2k0.vke.cn-beijing.volces.com` and `kubernetes.default.svc.cluster.local` |
| `upload.wikimedia.org` | `Timeout while downloading` |

`volces.com` is Volcano Engine, ByteDance's cloud; `cn-beijing` is its Beijing
region. So kie's image fetcher runs inside mainland China: the fal request was
intercepted and answered by a local cluster's own certificate, and Wikimedia —
blocked in China — simply timed out.

Both hosts answer normally from here (Wikimedia 301 in 0.17 s, fal serves the
file with a valid Sectigo certificate for `v3.fal.media`, verified). Nothing is
wrong with the image, its origin, the certificate or the model.

**Consequence for this project: kie.ai is not usable for any job that takes an
image URL**, unless the source is hosted somewhere reachable from mainland
China. Text-only jobs are unaffected. kie does not bill a failed task — the
balance stayed at 792 across both attempts.

That removes the price comparison from the decision entirely. fal it is.

**What the ground-truth comparison actually measures.** IoU against the
hand-made priest gave head 0.873, hand 0.560, chest 0.556, belly 0.493, eyes
0.355 and arm **0.000**. The zero is not a defect: the hand rig's `arm.webp`
is at x 722-882 and the machine cut the sleeve at x 101-331 — different arms.
The two decompositions simply draw different boundaries, which is expected and
allowed. So IoU against a hand rig measures *agreement*, not *quality*. For a
new figure there is no hand rig at all, so the number that carries weight is
the reconstruction: do the layers, stacked in order, give the original back.

## Job 2 — Fill what was behind (fallback)

Only needed if a layerize result comes back with a hole.

| Model | Provider | Price | Notes |
|---|---|---|---|
| `fal-ai/bria/eraser` | fal | $0.04 / generation | Purpose-built object removal, which is exactly this job stated the other way round. Licensed training data, commercially safe. |
| `fal-ai/flux-pro/v1/fill` | fal | see `get_pricing` | Classic mask-based inpainting. |
| `fal-ai/flux-2/klein/9b/edit` | fal | $0.011 / megapixel | Cheapest general edit. |
| `fal-ai/sam-3/image` | fal | $0.005 / run | Text-promptable masks, if a layer has to be cut by hand after all. |

**Verdict:** `bria/eraser` before generic inpainting. Removing an arm and
having the torso behind it reconstructed is object removal, not painting.

## Job 3 — Detail that does not exist in the flat image

An eye hidden behind hair, a hand seen from another angle, a head turned
slightly for a real three-quarter gaze instead of a fake 2D one.

| Model | Provider | Price | Notes |
|---|---|---|---|
| `fal-ai/qwen-image-edit-2511-multiple-angles` | fal | $0.035 / megapixel | **Generates the same subject from a different azimuth and elevation.** A genuinely different capability: a head actually turned, not a layer rotated. |
| `alibaba/qwen-image-3/edit` | fal | see `get_pricing` | Keeps facial features and identity across an edit. |
| `fal-ai/kling-image/o3/image-to-image` | fal | see `get_pricing` | Advertised for consistency across edits. |
| `bytedance/seedream/v5/lite/edit` | fal | $0.035 / image | Cheap general edit. |
| `fal-ai/bytedance/seedream/v4.5/edit` | fal | $0.04 / image | Older sibling, no reason to prefer it over v5 lite. |
| `xai/grok-imagine-image/v2.0/edit` | fal | **T** $0.00017 / compute second | Same model as kie's `grok-imagine-image-2-0/image-edit`. |

**Verdict:** multiple-angles is worth a real test. If it holds the painted
style, the `gaze` block stops being a 2D cheat and becomes a two-pose blend.

## Job 4 — Effect flip-books: lightning, fire, smoke

**Do not generate the frames one at a time.** Independent generations do not
agree with each other, so the flip-book flickers randomly instead of moving.

Generate a short video and cut it into frames:

| Step | Tool | Price |
|---|---|---|
| 2 second clip from a still | `fal-ai/kling-video/v2.5-turbo/standard/image-to-video` | $0.042 / second = **$0.084** |
| alternative | `wan/v2.6/image-to-video/flash` | $0.05 / second |
| cut into frames | local `ffmpeg 6.0` | free |
| optional, per frame | `fal-ai/birefnet/v2` | **T** $0.0008 / compute second |

A 2 second clip at 24 fps is 48 frames; a flip-book needs 4 to 8. So one clip
costs **$0.021 per frame if you keep 4, $0.011 if you keep 8** — against
$0.035 to $0.08 per frame for separate image generations. The saving holds at
either end, and the frames are temporally coherent, which separate
generations are not at any price.

**Transparency is free if the effect is generated on black.** Lightning, fire
and smoke on a black field composite correctly with
`mix-blend-mode: screen`, which Chromium 103 has had since Chrome 41. That
skips background removal entirely. Set `"blend": "screen"` on the layer.

## Job 5 — Separating figure from backdrop

| Model | Provider | Price | Notes |
|---|---|---|---|
| `fal-ai/birefnet/v2` | fal | **T** $0.0008 / compute second | High-resolution dichotomous segmentation. Sharpest on hair and cloth edges. |
| `fal-ai/bria/background/remove` | fal | see `get_pricing` | Licensed data, commercially safe. |
| `pixelcut/background-removal`, `fal-ai/imageutils/rembg`, `fal-ai/ideogram/remove-background` | fal | see `get_pricing` | Alternatives. |
| `recraft/remove-background` | kie | see kie pricing | The kie equivalent. |

**Verdict:** `birefnet/v2`. Note this is a *different* job from layerize:
background removal gives two pieces, foreground and background. It does not
separate an arm from a torso.

## Job 6 — Upscaling

The priest is 1000x1000. A website hero may want more.

| Model | Provider | Price | Notes |
|---|---|---|---|
| `topaz/upscale/image/precision` | fal | see `get_pricing` | Has a **CGI** model variant, which is the right one for painted art rather than photographs. |
| `fal-ai/clarity-upscaler` | fal | $0.03 / megapixel | General, high fidelity. |
| `fal-ai/seedvr/upscale/image` | fal | see `get_pricing` | SeedVR2. |
| `fal-ai/aura-sr`, `fal-ai/esrgan`, `fal-ai/recraft/upscale/crisp` | fal | see `get_pricing` | Cheaper, older. |

**Verdict:** not needed yet. Upscale the flat source once, before layerizing,
rather than upscaling nine layers afterwards.

---

## Considered and rejected

- **`recraft/remove-background` (kie)** — job 5, not job 1. It cannot separate
  an arm from a torso.
- **`qwen3/image-to-image` (kie)**, **`wan/2-7-image-pro` (kie)**,
  **`seedream/4.5-edit` (kie)**, **`grok-imagine-image-2-0/image-edit` (kie)**
  — all general edit or generation models. Useful for job 3 and job 4, no help
  at all for job 1. `seedream/4.5-edit` is superseded by v5.
- **`fal-ai/recraft/vectorize`** — raster to SVG. An SVG layer would scale
  without limit and animate in the DOM, which is tempting. Painted art with
  soft shading vectorises into flat blobs, so it is wrong for a figure. Might
  suit a hard-edged rune or sigil.
- **`fal-ai/flux-2-pro/outpaint`, `fal-ai/bria/expand`** — outpainting extends
  a frame outwards. This project needs the opposite.
- **`fal-ai/fashn/tryon`, `google/virtual-try-on`** — garment swapping. Would
  be the right family for a clothing variant of a figure, nothing more.
- **`fal-ai/sam2/image`, `fal-ai/evf-sam`** — superseded by SAM 3 for the
  fallback path.
