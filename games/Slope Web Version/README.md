# Slope // Vector

An original, dependency-free browser homage to the classic **Slope** formula. All rendering, UI, procedural generation, physics, and audio are implemented from scratch with HTML, CSS, Canvas 2D, and the Web Audio API. No assets or source code from the original game are included.

## Run it

Open `index.html` in any current desktop or mobile browser. No server or build step is required.

## Controls

- `A` / `D` or `←` / `→`: steer
- `P` or `Escape`: pause/resume
- `Enter` or `Space`: start/retry
- Touch: drag horizontally on the game canvas

## Included systems

- Endless seeded procedural track generation
- Original section progression: one early set, then early/middle sets, then early/middle/late sets, with every section capped by a red-bricked speed tunnel
- RNG-block platforms, left/right slants, narrow straights, treblocks, regular tunnels, snakes, horizontal movers (hors), and vertical movers (verts)
- Wider three-lane platforms, discrete inter-platform gaps, thin-but-playable straights/snakes, banked slants, automatic end ramps, and speed pads
- Ball/track physics, falling, collision, speed ramping, score, local high score
- Ball-centered chase camera locked directly behind the player
- Responsive keyboard and touch steering
- Menu, instructions, pause, results, and full settings screens
- Difficulty, initial/max speed, acceleration, track width, obstacle density, seed, sensitivity, FOV, render mode, glow, reduced motion, and effects-volume controls
- Lightweight synthesized effects with no background music or external audio files

## Performance modes

- **Auto** (default): starts balanced and reduces or restores detail based on measured render cost
- **Performance**: 1× pixel density, shorter scenery distance, sparse skyline, limited glow
- **Balanced**: 1× pixel density with medium scenery and restrained glow
- **Crisp**: up to 1.25× pixel density and maximum scenery detail

The renderer batches the track and skyline into depth groups, caches the solid background, avoids per-frame world sorting, culls distant geometry, and throttles HUD and world maintenance work.

## Research translated into the design

The implementation follows the original game's documented section pattern and named obstacle families while keeping the code independent. Hors begin at the left edge, wait a randomized 0–3 seconds, then take 3 seconds to cross; verts begin grounded and use the original 0/3/6-second activation offsets with 2-second ascent/descent phases. Gameplay uses automatic forward motion, left/right-only steering, rising speed, automatic ramp launches, and instant failure from red geometry or the void. The in-run view uses an opaque black world, dense green building grids, black/red hazard blocks, a black/green grid ball, a fixed chase camera, projected line weights, and the original-style single score at the top center.
