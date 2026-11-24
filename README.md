# codevember-2026

One three.js sketch per day for Codevember 2026. No build step: each day is a
folder with `index.html` + `main.js` that pulls shared code through an import map.

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

Code is [MIT](LICENSE). Most of it was written with AI assistance (Claude), directed,
reviewed and edited by the author.

Third-party libraries in `third_party/` (three.js, guspira, Ammo, ...) and assets
(sounds, models, HDRIs) keep their own licenses, credited in each day's README. Some
are not MIT: day 19's grinding sample is CC BY-NC 4.0 (non-commercial only) and day
25's skull model is CC BY 4.0 (attribution required).
