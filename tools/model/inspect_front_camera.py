"""Read-only check of the LAYERED_Front_Composition camera in a .blend (why the exported VIEW_ marker is identity).

  node tools/model/run-blender.mjs tools/model/inspect_front_camera.py -- <source.blend> <out.json>

Lists the file's scenes, then appends ONLY that camera object (plus whatever its parent/constraints reference)
into an empty session, and reports its stored transform, parent, constraints, and the evaluated world matrix.
The source file is never saved.
"""
import bpy, json, sys

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = argv[0], argv[1]
NAME = 'LAYERED_Front_Composition'

with bpy.data.libraries.load(SRC, link=False) as (src, dst):
    scenes = list(src.scenes)
    has = NAME in src.objects
    if has:
        dst.objects = [NAME]
info = dict(scenes=scenes, camera_in_file=has)
if has:
    cam = bpy.data.objects[NAME]
    rows = lambda m: [[round(v, 6) for v in r] for r in m]
    info.update(
        type=cam.type, parent=cam.parent.name if cam.parent else None, parent_type=cam.parent_type if cam.parent else None,
        location=list(cam.location), rotation_mode=cam.rotation_mode, rotation_euler=list(cam.rotation_euler),
        rotation_quaternion=list(cam.rotation_quaternion), scale=list(cam.scale),
        matrix_basis=rows(cam.matrix_basis), matrix_world_stored=rows(cam.matrix_world),
        constraints=[dict(type=c.type, name=c.name, enabled=not c.mute, influence=c.influence,
                          target=getattr(c, 'target', None).name if getattr(c, 'target', None) else None,
                          track_axis=getattr(c, 'track_axis', None), up_axis=getattr(c, 'up_axis', None)) for c in cam.constraints],
        lens=cam.data.lens, sensor_width=cam.data.sensor_width, sensor_fit=cam.data.sensor_fit, angle_x=cam.data.angle_x,
        shift=[cam.data.shift_x, cam.data.shift_y],
        users_scene=[s.name for s in cam.users_scene],
    )
    # evaluate it: link into the (empty) factory scene with its constraint targets, then let the depsgraph run
    sc = bpy.context.scene
    for o in [cam] + [c.target for c in cam.constraints if getattr(c, 'target', None)] + ([cam.parent] if cam.parent else []):
        if o.name not in sc.collection.objects:
            sc.collection.objects.link(o)
    bpy.context.view_layer.update()
    info['matrix_world_evaluated'] = rows(cam.evaluated_get(bpy.context.evaluated_depsgraph_get()).matrix_world)
    for c in cam.constraints:
        t = getattr(c, 'target', None)
        if t:
            info.setdefault('constraint_targets', {})[t.name] = dict(location=list(t.location), matrix_world=rows(t.matrix_world), parent=t.parent.name if t.parent else None)
json.dump(info, open(OUT, 'w'), indent=1)
print('CAMERA_OK', json.dumps({k: info.get(k) for k in ('camera_in_file', 'parent', 'location', 'constraints')}))
