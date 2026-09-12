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

### kie.ai needs its own upload — and bills more than it lists

The first two kie attempts failed before the model ran, and the reason was the
network, not the model:

| Source given to kie | What kie's server reported |
|---|---|
| `v3b.fal.media` (fal's CDN) | TLS verification failed — the certificate names `cd8ukg94e1omtfb44s2k0.vke.cn-beijing.volces.com` and `kubernetes.default.svc.cluster.local` |
| `upload.wikimedia.org` | `Timeout while downloading` |

`volces.com` is Volcano Engine, ByteDance's cloud; `cn-beijing` is its Beijing
region. kie's image fetcher runs inside mainland China: the fal request was
answered by a local cluster's own certificate, and Wikimedia — blocked there —
timed out. Both hosts answer normally from here.

**The fix is kie's own file API, not a different host.** That is exactly what
their Playground does when you drop a file into the form:

```bash
curl -X POST https://kieai.redpandaai.co/api/file-stream-upload   -H "Authorization: Bearer $KIE_AI_API_KEY"   -F file=@source.png -F uploadPath=images/xy -F fileName=source.png
# -> data.downloadUrl on tempfile.redpandaai.co, kept for three days, free
```

`tools/kie-upload.py` does this. Two traps in their docs: one page gives the
host as `api.kie.ai`, which returns **404** — the working host is
`kieai.redpandaai.co`. And the result files sit on `tempfile.aiquickdraw.com`,
which refuses Python's default user agent with **403**; fetch them with curl.

With the upload in place the job ran and matched fal, as it should — same
model:

| | fal seedream | kie seedream |
|---|---|---|
| colour distance | 9.2 / 255 | **7.3 / 255** |
| double-covered | 6.5 % | **4.4 %** |
| figure covered by no part | 21.2 % | **11.1 %** |
| mean IoU vs the hand rig | 0.473 | **0.484** |

That gap is run-to-run variation of one model, not a provider difference.

**The price is not the listed one.** kie lists `$0.0375 per image`. Measured:
the balance went from 792 to 708 credits, so **84 credits = $0.42** for one
run — eleven times the list price. The job returned seven images (base plus six
layers), so it is probably billed per output image rather than per call. That
is not confirmed; the difference is. Check the balance before and after the
first run of any new kie model rather than trusting the price page:

```bash
curl -H "Authorization: Bearer $KIE_AI_API_KEY" https://api.kie.ai/api/v1/chat/credit
```

**Verdict: use fal.** Not on quality — the model is identical — but because
fal needs no upload hop, has no China routing in the path, and its listed
prices have not been caught misreporting by an order of magnitude.

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

**Verdict: not a fallback. This step is required.** Measured on the priest:
Seedream's base plate is black across **85 %** of the area its own lifted
layers cover, and 82.3 % inside the hand's box. It cuts holes; it does not
paint behind them. It also painted the source's transparent background solid
black - 53.3 % of the canvas.

`fal-ai/bria/eraser` with `preserve_alpha: true` fixes both in one call for
$0.04: erase the moving parts from the flat source, keep the alpha. The result
came back 46.7 % opaque, exactly matching the source, with both shoulders, the
lapels, the white collar and the watch chain running continuously through the
places the hand and arm had been.

Dilate the mask by about 4 px first, or a one-pixel rim of the erased part
survives at the edge.

**Then feather.** Layerize output has hard alpha - only 0.18 to 0.31 % of each
layer's pixels are semi-transparent. Where a layer's edge is the figure's real
silhouette that is fine; where it is an internal cut it is not. The priest's
head layer ended in a hard horizontal line across the neck, which slid over
the base as a second contour behind the face the moment the head moved.
`tools/feather-layers.py` erodes then blurs each layer's alpha - eroding first,
because blurring alone spreads the layer into pixels it has no colour for and
leaves a dark halo. About 1 % soft pixels, under 1.2 % area lost, and the seam
is gone.

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
