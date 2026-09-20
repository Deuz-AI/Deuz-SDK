"""
Export the Deuz mascot from its Blender file to the GLB the home-page hero loads.

    blender -b path/to/mr.deuz.blend --python tooling/export-mascot.py -- --out public/mascot/deuz-mascot.glb

Run from `docs/`. Nothing is written back to the .blend. The contract the output has
to meet is in MASCOT-MODEL.md; this script gets the studio file there:

  1. keeps the mascot only (everything under the `DEUZ | Master` empty that renders);
     cameras, lights, the floor, the reference image and the default cube are dropped
  2. clamps subdivision, turns the bevelled curves (arms, legs, seams) into meshes and
     decimates every part against one triangle budget, so the whole thing stays under
     the hero's limit without anyone retouching the model
  3. swaps the eight studio materials for exactly two, `Ink` and `Paper`, by lightness
  4. gives the Paper parts an inverted-hull outline, the black line of the cartoon
  5. joins the pieces into the contract's node names — `Head` with `Pupil` inside it,
     `ArmL`/`ArmR`, `HandL`/`HandR`, `LegL`/`LegR`, `ShoeL`/`ShoeR` — and scales the
     figure to 1.8 units, feet on the ground, facing +Z

Options after `--`: `--budget` (triangles before the outline, default 14000),
`--outline` (hull thickness in the file's own units, 0 disables, default 0.035),
`--height` (final height, 0 keeps the file's units, default 1.8).
"""

import argparse
import sys

import bpy
from mathutils import Matrix, Vector

ROOT_NAME = "DEUZ | Master"

# Which objects make up which node, by the prefix the file uses for them. Order matters:
# the first match wins.
GROUPS = [
    ("Pupil", ("Face |",)),
    ("Head", ("Body |",)),
    ("ArmL", ("Arm L",)),
    ("ArmR", ("Arm R",)),
    ("HandL", ("Glove_L",)),
    ("HandR", ("Glove_R",)),
    ("LegL", ("Leg L",)),
    ("LegR", ("Leg R",)),
    ("ShoeL", ("Boot L",)),
    ("ShoeR", ("Boot R",)),
]

# Parts that never get the outline even though they are Paper: the rim already frames the face.
NO_OUTLINE = ("Body |",)

MIN_TRIS = 150  # floor per part, so a stitch ring does not collapse into a hexagon


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="where to write the .glb")
    parser.add_argument("--budget", type=int, default=14000)
    parser.add_argument("--outline", type=float, default=0.035)
    parser.add_argument("--height", type=float, default=1.8)
    return parser.parse_args(argv)


def log(*parts):
    print("[export-mascot]", *parts, flush=True)


def run_op(op, objects, active=None, **kwargs):
    """Run an object-mode operator on exactly these objects, whatever the saved selection was."""
    active = active or objects[0]
    with bpy.context.temp_override(
        selected_objects=list(objects),
        selected_editable_objects=list(objects),
        active_object=active,
        object=active,
    ):
        for obj in bpy.context.view_layer.objects:
            obj.select_set(obj in objects)
        bpy.context.view_layer.objects.active = active
        return op(**kwargs)


def group_of(name):
    for node, prefixes in GROUPS:
        if name.startswith(prefixes):
            return node
    return None


def luminance(material):
    color = material.diffuse_color
    if material.node_tree:
        for node in material.node_tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                color = node.inputs["Base Color"].default_value
                break
    return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]


def triangles(obj):
    mesh = obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    try:
        return sum(len(polygon.vertices) - 2 for polygon in mesh.polygons)
    finally:
        obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh_clear()


def base_triangles(obj):
    return sum(len(polygon.vertices) - 2 for polygon in obj.data.polygons)


def decimate_ratios(counts, budget):
    """One global ratio, with a per-part floor, that lands the total on the budget."""

    def total(ratio):
        return sum(min(count, max(MIN_TRIS, count * ratio)) for count in counts.values())

    low, high = 0.0, 1.0
    if total(1.0) <= budget:
        return {name: 1.0 for name in counts}
    for _ in range(60):
        mid = (low + high) / 2
        if total(mid) > budget:
            high = mid
        else:
            low = mid
    return {name: min(1.0, max(MIN_TRIS, count * low) / count) for name, count in counts.items()}


def world_bounds(objects):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    low = Vector((float("inf"),) * 3)
    high = Vector((float("-inf"),) * 3)
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        for corner in evaluated.bound_box:
            point = evaluated.matrix_world @ Vector(corner)
            low = Vector(map(min, low, point))
            high = Vector(map(max, high, point))
    return low, high


def main():
    args = parse_args()
    root = bpy.data.objects[ROOT_NAME]

    # 1. The mascot and nothing else.
    parts = [
        obj
        for obj in root.children_recursive
        if obj.type in {"MESH", "CURVE"} and not obj.hide_render and obj.name in bpy.context.view_layer.objects
    ]
    for obj in list(bpy.data.objects):
        if obj is not root and obj not in parts:
            bpy.data.objects.remove(obj, do_unlink=True)
    for obj in parts:
        obj.hide_set(False)
        obj.hide_viewport = False
        if group_of(obj.name) is None:
            log(f"warning: {obj.name!r} matches no group and stays a loose child of the root")

    # 2a. Curves become meshes; subdivision is clamped (a sculpt does not need it at all).
    curves = [obj for obj in parts if obj.type == "CURVE"]
    if curves:
        run_op(bpy.ops.object.convert, curves, target="MESH")
    for obj in parts:
        dense = base_triangles(obj) > 3000
        for modifier in list(obj.modifiers):
            if modifier.type != "SUBSURF":
                continue
            if dense:
                obj.modifiers.remove(modifier)
            else:
                modifier.levels = min(modifier.levels, 1)
                modifier.render_levels = modifier.levels

    # 3. Two materials. Done before the outline so the hull can point at the Ink slot.
    ink = bpy.data.materials.new("Ink")
    ink.diffuse_color = (0, 0, 0, 1)
    paper = bpy.data.materials.new("Paper")
    paper.diffuse_color = (1, 1, 1, 1)
    for material in (ink, paper):
        material.use_nodes = True
        material.use_backface_culling = True  # exported as single-sided: the outline hull depends on it
        bsdf = material.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = material.diffuse_color
            bsdf.inputs["Roughness"].default_value = 1.0
    roles = {}
    for obj in parts:
        for slot in obj.material_slots:
            if slot.material and slot.material not in (ink, paper):
                roles.setdefault(slot.material.name, luminance(slot.material) >= 0.5)
                slot.material = paper if roles[slot.material.name] else ink
        if not obj.material_slots:
            obj.data.materials.append(ink)
    for name, is_paper in sorted(roles.items()):
        log(f"material {name!r} -> {'Paper' if is_paper else 'Ink'}")

    # 2b. Decimate against the budget, then 4. outline the Paper parts, and bake both in.
    counts = {obj.name: triangles(obj) for obj in parts}
    ratios = decimate_ratios(counts, args.budget)
    for obj in parts:
        if ratios[obj.name] < 1.0:
            decimate = obj.modifiers.new("Budget", "DECIMATE")
            decimate.decimate_type = "COLLAPSE"
            decimate.ratio = ratios[obj.name]
        all_paper = all(slot.material is paper for slot in obj.material_slots)
        if args.outline > 0 and all_paper and not obj.name.startswith(NO_OUTLINE):
            obj.data.materials.append(ink)
            hull = obj.modifiers.new("Outline", "SOLIDIFY")
            hull.thickness = args.outline
            hull.offset = 1.0
            hull.use_flip_normals = True
            hull.use_rim = False
            hull.material_offset = len(obj.material_slots) - 1
    run_op(bpy.ops.object.convert, parts, target="MESH")

    # 5. Join into the contract's nodes. Joining deletes every member but the active one,
    # so membership is settled by name first and the objects are looked up as we go.
    membership = {node: [obj.name for obj in parts if group_of(obj.name) == node] for node, _ in GROUPS}
    nodes = {}
    for node, names in membership.items():
        if not names:
            log(f"warning: nothing matched {node!r}")
            continue
        members = [bpy.data.objects[name] for name in names]
        if len(members) > 1:
            run_op(bpy.ops.object.join, members, active=members[0])
        joined = members[0]
        joined.name = node
        joined.data.name = f"{node}_geo"  # a mesh named like its node would shadow it in three.js
        # Bake rotation and scale into the mesh: the gaze code moves the pupil in the Head's
        # local X/Y, so every node's axes have to be the world's. Then put the origin in the middle.
        run_op(bpy.ops.object.transform_apply, [joined], location=False, rotation=True, scale=True)
        run_op(bpy.ops.object.origin_set, [joined], type="ORIGIN_GEOMETRY", center="BOUNDS")
        nodes[node] = joined
    if "Pupil" in nodes and "Head" in nodes:
        pupil, head = nodes["Pupil"], nodes["Head"]
        keep = pupil.matrix_world.copy()
        pupil.parent = head
        pupil.matrix_world = keep
    root.name = "Mascot"

    # Ground it, centre it, and scale it to the contract's height. The scale goes into the
    # vertices and the node offsets rather than onto the root node, so every node ends up
    # at unit scale and the gaze code's head-local units are world units.
    low, high = world_bounds(nodes.values())
    size = high - low
    scale = args.height / size.z if args.height > 0 else 1.0
    for obj in nodes.values():
        obj.data.transform(Matrix.Scale(scale, 4))
        obj.location *= scale
    root.location = Vector((-(low.x + high.x) / 2, -(low.y + high.y) / 2, -low.z)) * scale
    log(f"bounds {[round(v, 3) for v in size]} in file units, exported at scale {scale:.4f}")

    # Export.
    options = dict(
        filepath=args.out,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_materials="EXPORT",
        export_image_format="NONE",
        export_texcoords=False,
        export_normals=True,
        export_tangents=False,
        export_attributes=False,
        export_vertex_color="NONE",
        export_skins=False,
        export_morph=False,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_draco_mesh_compression_enable=False,
        use_selection=False,
        use_visible=False,
        use_renderable=False,
    )
    while True:
        try:
            bpy.ops.export_scene.gltf(**options)
            break
        except TypeError as error:  # an option this Blender does not know: drop it and retry
            message = str(error)
            unknown = next((key for key in list(options) if f'"{key}"' in message), None)
            if unknown is None or unknown == "filepath":
                raise
            log(f"note: this Blender has no {unknown!r} export option, skipping it")
            del options[unknown]

    for node, obj in nodes.items():
        log(f"{node:<6} {base_triangles(obj):>6} tris  materials={[s.material.name for s in obj.material_slots]}")
    log(f"total {sum(base_triangles(obj) for obj in nodes.values())} tris -> {args.out}")


main()
