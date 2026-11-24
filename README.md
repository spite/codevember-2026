# Codevember 2026

One real-time three.js sketch per day of November 2026, each answering that day's
prompt. Live at **https://spite.github.io/codevember-2026/**.

The aim is a photographic look across every day: PBR materials, soft shadows,
ambient occlusion and a bounce of global illumination, studio or HDR lighting and
AgX tonemapping, with physical motion. Every day randomizes (R, or by itself after a
few seconds), keeps its seed and settings in the url, works on phones, and most have
sound. Each day's `README.md` describes it, and its `explainer.html` ("How it works")
walks through how it's made.

## Days

| Day | Prompt | What it is |
|---|---|---|
| [1](1/) | Fold | Paper polyhedra folding up from their flat nets |
| [2](2/) | Shatter | An object a split second after it bursts, like a high-speed photograph |
| [3](3/) | Melt | A floating object melting under a coat of glossy liquid |
| [4](4/) | Tangle | Nested coils of iridescent bands |
| [5](5/) | Moss | A reaction-diffusion sculpture slowly overgrown by moss |
| [6](6/) | Orrery | An engraved metal sphere whose surface is a working mechanism |
| [7](7/) | Hollow | A solid sculpture that hollows itself out |
| [8](8/) | Tesseract | Infinity polyhedra, in homage to Anthony James |
| [9](9/) | Membrane | Soft jelly bodies tumbling inside a hollow shell |
| [10](10/) | Caustic | Acid etching a polished metal blank |
| [11](11/) | Rust | Floating clockwork gear trains that really work, left to rust |
| [12](12/) | Feather | Tori and torus knots covered in feathers |
| [13](13/) | Labyrinth | A playable handheld labyrinth carved onto closed 3D surfaces |
| [14](14/) | Tension | An object in zero gravity wrapped in a clinging coat of water |
| [15](15/) | Mirage | A holographic card dashing down a synthwave tunnel to the music |
| [16](16/) | Spore | A colony of spores floating in a shaft of light |
| [17](17/) | Kelp | A giant kelp forest seen from the reef, looking up into the sun |
| [18](18/) | Pendulum | A pendulum swinging through a row of gates, always just in time |
| [19](19/) | Erosion | Suspended beach glass floating through each other |
| [20](20/) | Cocoon | A dancing figure slowly wrapped in silk |
| [21](21/) | Bolt | Electricity arcing through a glass object |
| [22](22/) | Echo | An endless back-rooms labyrinth you can only see by calling out |
| [23](23/) | Magma | A rock of cooling crust over molten magma |
| [24](24/) | Nest | Infinite nested matryoshka dolls |
| [25](25/) | Veil | A skull that follows your head through the webcam, under a simulated veil (in progress) |

## What's in the repo

- `N/`: one folder per day: `index.html`, `main.js` and its own modules, assets and
  sounds, a `README.md` and an `explainer.html`.
- `index.html`: the gallery, with thumbnails from `screenshots/`.
- `modules/`: code shared by the days.
  - `common.js`: renderer, camera, controls, the render loop, keys, seeded
    randomness, url state, loading progress and hints.
  - `pipeline/`: the forward WebGL2 rendering pipeline most days use (PCSS shadows,
    GTAO + SSIL, MSAA, bloom, motion blur, depth of field, AgX), with its own
    [explainer](modules/pipeline/explainer.html).
  - `polyhedra/`, `physics/` (Ammo/Bullet), `fumes/` (smoke simulation),
    `materials/`, `suzanne/`, `autoChange.js` (kiosk mode), and math, noise and
    palette helpers.
- `shaders/`: shared GLSL snippets (SDFs, noise, triplanar, easings).
- `default/`: the template a new day starts from.
- `third_party/`: vendored three.js r187 and addons, guspira (the GUI) and Ammo.
- `assets/`: shared icons, HDRIs and models.
- `tools/`: the deploy's minifier and bundler, a render regression test
  (`regress/`) and a performance harness (`perf/`).

## Running it

There's no build step: each day is plain ES modules with an import map. Serve the
repo root with any static server and open a day:

```
python3 -m http.server 8000
# http://localhost:8000/1/
```

Pushing to `main` deploys a minified, bundled copy to GitHub Pages
(`.github/workflows/deploy.yml`, `tools/minify.mjs`, `tools/bundle.mjs`).

## New day

Copy `default/` to `N/`, build the day's prompt from `modules/days.js`, write the
README, and add the day to `published` there when it's ready. The day number is taken from the folder name.

## Base (`modules/common.js`)

- `renderer`, `camera`, `controls`; `getCamera(fov)`, `getOrthoCamera(height)`.
- `render(({ time, dt, frame }) => ...)`: `time` and `dt` stop while paused.
- `onResize((w, h, dpr) => ...)`: size render targets at `w * dpr` by `h * dpr`.
- `onRandomize(fn)`: R / the randomize button picks a new seed (stored in the
  url as `?seed=`) and calls these; `Math.random` is seeded, and loading a url
  with a seed replays them, so register them before calling `render()`.
- `addKey(code, description, fn)` and `keysHelp()` for the GUI help text.
- `getComposer()` creates the EffectComposer only when a sketch needs one.
- `addActionButton(icon, title, fn)` adds a button next to the GUI.
- `fromDefaults(defaults, options)` is guspira's `createParams`: one signal per key.
- `#loading` in `index.html` is shown from first paint and fades out after the first
  `render()` frame (or an earlier `ready()`); set `--loading-background` on it to the
  day's backdrop colour. It is removed at once with `?capture`.

The GUI is [guspira](https://github.com/spite/guspira) 0.2.0, vendored as
`third_party/guspira.js` (import from `"guspira"`) with its stylesheet in `css/gui.css`.

Keys: Space pause, R randomize, Tab hide UI, P screenshot (Shift+P at 2x).

Url parameters: `seed`, `dpr` (max pixel ratio, default 2), `w`/`h` (fixed
canvas size), `capture` (hides the UI).

three.js r187.

## License

Code is [MIT](LICENSE). Most of it was written with AI assistance, directed, reviewed
and edited by the author:

- Assistants: [Claude Code](https://claude.com/claude-code) and
  [Antigravity](https://antigravity.google).
- Models: Claude Opus 5.5 and Claude Fable 5.2 (Anthropic), and Gemini 4 Carbon,
  Gemini 4 Hydrogen and Gemini 4 Neon (Google). Some days were started in Antigravity
  and finished in Claude Code; each day's explainer (or README, for days without one)
  says which.
- Day 22's voices were generated with Gemini Flash 3.8 TTS, and the soundtracks of days
  13 and 23 with Lyria 3.5.

Third-party libraries in `third_party/` (three.js, guspira, Ammo, ...) and assets
(sounds, models, HDRIs) keep their own licenses, credited in each day's README. Some
are not MIT: day 19's grinding sample is CC BY-NC 4.0 (non-commercial only) and day
25's skull model is CC BY 4.0 (attribution required).
