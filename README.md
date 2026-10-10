# Mixamo to Unreal

Converts Mixamo FBX animations for Unreal Engine. Runs entirely in the browser (no server, no dependencies).

[![Try it out](https://img.shields.io/badge/Try%20it%20out-ff7a45?style=for-the-badge)](https://lukerrr.github.io/mixamo-to-unreal/)

What it does:
- adds a root bone above `Hips` (including the bind pose);
- moves the horizontal hips movement onto the root so root motion works (can be turned off);
- optionally moves the hips turning (yaw around the vertical axis) onto the root as well;
- renames bones to UE Mannequin names (`pelvis`, `spine_01`, `thigh_l`…);
- removes the empty duplicate `Take 001` that Mixamo puts into files with skin.

Skin, framerate, meshes and materials are kept as is.

## Running

```bash
python3 -m http.server 8173
```
Open http://localhost:8173.

## Layout
- `src/fbx.js`: binary FBX 7.x reader/writer. An unmodified file round-trips byte-for-byte.
- `src/convert.js`: the conversion itself.
- `src/zip.js`: bundles several results into a ZIP.

## License

MIT
