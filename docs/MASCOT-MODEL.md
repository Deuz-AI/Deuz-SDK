# The mascot model

The home page hero renders the Deuz mascot in 3D with three.js
(`components/home/mascot-scene.tsx`). It looks for one file:

```
docs/public/mascot/deuz-mascot.glb
```

While that file is absent the hero shows the logo itself in 3D — the ring and the dot
— driven by the same code, so nothing here blocks the site. Drop the export in, rebuild,
and the mascot replaces it. The PNG (`deuz-mascot.png` next to it) stays as the
server-rendered fallback for no-JS, no-WebGL and reduced-motion visitors.

## Export contract

| | Requirement |
| --- | --- |
| Format | glTF 2.0 binary (`.glb`), no Draco or meshopt compression (plain `KHR_mesh_quantization` is fine), no embedded lights or cameras |
| Orientation | `+Y` up, character facing `+Z` (toward the camera), origin between the feet on the ground |
| Scale | About 1.8 units tall; the scene auto-frames whatever it loads, so exact size is forgiving |
| Budget | ≤ 30k triangles, ideally well under 300 KB |
| Modifiers | Applied on export — including the inverted-hull outline, which is what gives the cartoon its black line |
| Materials | Exactly two, named **`Ink`** and **`Paper`**. The scene recolours them by name (black/white in light mode, inverted in dark mode), so shader setup and textures do not matter |
| Nodes | **`Head`** and **`Pupil`** (a child of `Head`, centred on the face) are required for the gaze — the pupil follows the pointer. Optional: `ArmL`, `ArmR`, `HandR`, `LegL`, `LegR`, `ShoeL`, `ShoeR` |
| Animation clips | Optional, by name: **`Idle`** (looped), **`Point`** (played once on appearance — the raised finger), **`Hop`** (played on click). With no clips the scene bobs and sways the whole model itself |

Anything not named in the table is ignored; a material with an unknown name is
assigned by its lightness (dark → `Ink`, light → `Paper`).

## Exporting from Blender

The source is `mr.deuz.blend`, a studio scene (cameras, lights, a floor, the reference
drawing) around the posed figure, with eight materials and about 260k triangles once
subdivision is applied. It is not kept in this repository. One command turns it into
the file above:

```
npm run mascot:export -- path/to/mr.deuz.blend
```

That runs Blender headlessly with `tooling/export-mascot.py` — it finds Blender through
`BLENDER`, then `PATH`, then the default install folders — and then quantizes the result
with gltf-transform (`npx`, no install). The script does the whole contract for you:

- keeps only the figure (the children of the `DEUZ | Master` empty that render) and
  drops the studio, the default cube and the reference image;
- turns the bevelled curves into meshes, clamps subdivision and decimates every part
  against one triangle budget (`--budget`, default 14000 before the outline);
- replaces the studio materials with `Ink` and `Paper`, chosen by lightness;
- adds the inverted-hull outline to the Paper parts (`--outline`, in the file's units,
  `0` to skip) since the file has none;
- joins the pieces into `Head` with `Pupil` inside it, `ArmL`/`ArmR`, `HandL`/`HandR`,
  `LegL`/`LegR`, `ShoeL`/`ShoeR`, bakes every rotation and the scale into the meshes, and
  stands the figure 1.8 units tall on the origin (`--height`).

Parts are matched by the name prefixes the file uses (`Body |`, `Face |`, `Arm L`,
`Glove_R_` and so on); the table at the top of the script is the place to change them
if the model is renamed. The quantization is `KHR_mesh_quantization`, which three.js
reads natively — it is not Draco or meshopt and needs no decoder.

The export carries no animation clips, so the hero bobs, sways and hops the whole
figure itself. The .blend has none yet, and joining the parts would drop object-level
keyframes anyway; when the figure gets rigged with `Idle`, `Point` and `Hop`, the
join step and the `export_animations` option in the script are what to revisit.

### By hand

If you export from Blender's UI instead, the checklist is:

1. Select the mascot objects only (File → Export → glTF 2.0 → *Selected Objects*).
2. Format **glTF Binary (.glb)**; Transform **+Y Up** (the default).
3. Data → Mesh: *Apply Modifiers* on; Materials: *Export*; Compression: **off**.
4. Animation: *Animation mode: Actions*, and make sure the actions are named `Idle`,
   `Point`, `Hop`.
5. Save as `docs/public/mascot/deuz-mascot.glb`, then `npm run build` in `docs/`.

## Smoke test without the real model

Export Blender's default cube renamed `Head` with a small sphere child named `Pupil`
and a material named `Ink`. It should load, sit on its shadow, turn white on the dark
toggle and follow the pointer with the sphere. Delete it afterwards — do not commit
test files under `public/mascot/`.
