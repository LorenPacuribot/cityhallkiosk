"""Export the revision 09 runtime building to browser GLB assets (staging directory).

  node tools/model/run-blender.mjs tools/model/export_cityhall_web.py -- <source.blend> <expected_sha256> <staging_dir>

Then `node tools/model/build-release.mjs` copies textures, writes the manifest and validates the GLBs.

What this does (see docs/3D_MODEL_INTEGRATION_GUIDE.md §5–6):
  * verifies the source .blend hash, then APPENDS only scene UNITY_Baked_Optimized into an empty session.
    The source file is read as a library and never saved; nothing is written next to it.
  * exports collection UNITY_Optimized_Geometry: building (everything except ENV_) and scenery (ENV_ cards)
    as two GLBs, glTF Y-up, hierarchy and custom properties kept, no centring or scaling.
  * keeps both UV sets (BaseUV -> TEXCOORD_0, LightmapUV -> TEXCOORD_1) and the linear Albedo colour layer
    (COLOR_0). Materials become minimal placeholders that keep the binding name; the browser rebuilds the
    real baked / PBR / projected materials from materials.json.
  * ENV_ projector data (UV0 = projector XY, UV1.x = projector depth) is copied into scalar corner
    attributes _PROJ_X/_PROJ_Y/_PROJ_DEPTH so glTF's UV V-flip cannot alter it.
  * stamps a deterministic assetId on every object and writes nodes.json, viewpoints.json and
    export-report.json. The report holds per-object triangle-corner sums (world position, both UVs, colour,
    projector scalars). Those sums do not change when the exporter splits vertices at seams, so the
    validator can prove the GLB carries the same data.
"""
import bpy, bmesh, hashlib, json, os, sys, math
import numpy as np
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, EXPECTED_SHA, OUT = argv[0], argv[1].lower(), argv[2]
SCENE, COLL = 'UNITY_Baked_Optimized', 'UNITY_Optimized_Geometry'
MODEL_VERSION = 'r09-web01'
UV_BASE, UV_LIGHT, COLOR = 'BaseUV', 'LightmapUV', 'Albedo'
os.makedirs(OUT, exist_ok=True)


def fail(msg):
    print('EXPORT_FAILED:', msg, flush=True)
    sys.exit(1)


# ------------------------------------------------------------------ 1. source hash
h = hashlib.sha256()
with open(SRC, 'rb') as f:
    for chunk in iter(lambda: f.read(1 << 20), b''):
        h.update(chunk)
SRC_SHA = h.hexdigest()
if SRC_SHA != EXPECTED_SHA:
    fail(f'source hash {SRC_SHA} does not match expected {EXPECTED_SHA}')
SRC_BYTES = os.path.getsize(SRC)

# ------------------------------------------------------------------ 2. append only the runtime scene
with bpy.data.libraries.load(SRC, link=False) as (src, dst):
    if SCENE not in src.scenes:
        fail(f'scene {SCENE} not in source: {src.scenes}')
    dst.scenes = [SCENE]
appended = bpy.data.scenes[SCENE]
coll = bpy.data.collections.get(COLL)
if coll is None:
    fail(f'collection {COLL} missing')

# work in the factory scene: link the runtime collection there, drop the appended scene wrapper so only one
# scene exists (the preview-lighting collection and any other appended collections become unused).
work = bpy.context.scene
for ob in list(work.collection.objects):
    bpy.data.objects.remove(ob, do_unlink=True)  # factory cube / camera / light
work.collection.children.link(coll)
bpy.data.scenes.remove(appended)
vl = bpy.context.view_layer
vl.update()

objects = sorted(coll.all_objects, key=lambda o: o.name)
if not objects:
    fail('collection is empty')


def prefix(name):
    return name.split('_', 1)[0]


ROLE = {'STATIC': 'static', 'DOOR': 'door_root', 'DOORGEO': 'door_geometry', 'SIGNFACE': 'sign_face',
        'ENV': 'scenery', 'VIEW': 'viewpoint'}


def role_of(o):
    p = prefix(o.name)
    if p == 'VIEW':
        return 'viewpoint_target' if o.name.endswith('_TARGET') else 'viewpoint_up' if o.name.endswith('_UP') else 'viewpoint'
    return ROLE.get(p, 'unknown')


def asset_id(o):
    # deterministic: the runtime object name is unique inside the collection and stable for this model version
    return f'{MODEL_VERSION}:{o.name}'


unknown = [o.name for o in objects if role_of(o) == 'unknown']

# ------------------------------------------------------------------ 3. projector scalars on ENV_ cards
env = [o for o in objects if o.type == 'MESH' and o.name.startswith('ENV_')]
for o in env:
    me = o.data
    uvs = list(me.uv_layers)
    if len(uvs) < 2:
        fail(f'{o.name}: expected projector XY and depth UV layers, found {[u.name for u in uvs]}')
    n = len(me.loops)
    xy = np.empty(n * 2, dtype=np.float32); uvs[0].data.foreach_get('uv', xy)
    dz = np.empty(n * 2, dtype=np.float32); uvs[1].data.foreach_get('uv', dz)
    for name, values in (('_PROJ_X', xy[0::2]), ('_PROJ_Y', xy[1::2]), ('_PROJ_DEPTH', dz[0::2])):
        if name in me.attributes:
            me.attributes.remove(me.attributes[name])
        a = me.attributes.new(name, 'FLOAT', 'CORNER')
        a.data.foreach_set('value', np.ascontiguousarray(values))
    me.update()

# ------------------------------------------------------------------ 4. minimal materials keeping the binding key
used = {}
for o in objects:
    if o.type != 'MESH':
        continue
    for s in o.material_slots:
        if s.material is None:
            fail(f'{o.name}: empty material slot')
        used[s.material.name] = s.material
for name, m in used.items():
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    for k in list(m.keys()):
        del m[k]
    m['binding'] = name

# ------------------------------------------------------------------ 5. ids, metadata and invariant sums
for o in objects:
    for k in list(o.keys()):
        if k in ('assetId', 'sourceName'):
            del o[k]
    o['assetId'] = asset_id(o)
    o['sourceName'] = o.name

R = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))  # Blender Z-up -> glTF Y-up
dg = bpy.context.evaluated_depsgraph_get()


def corner_sums(o):
    """Sums over every triangle corner (evaluated mesh, world space after R). Invariant under vertex splitting."""
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    try:
        me.calc_loop_triangles()
        tris = len(me.loop_triangles)
        loops = np.empty(tris * 3, dtype=np.int32); me.loop_triangles.foreach_get('loops', loops)
        mat_idx = np.empty(tris, dtype=np.int32); me.loop_triangles.foreach_get('material_index', mat_idx)
        vidx = np.empty(len(me.loops), dtype=np.int32); me.loops.foreach_get('vertex_index', vidx)
        co = np.empty(len(me.vertices) * 3, dtype=np.float64); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
        mw = np.array(R @ o.matrix_world, dtype=np.float64)
        world = co @ mw[:3, :3].T + mw[:3, 3]
        corner_pos = world[vidx[loops]]
        out = dict(triangles=tris, pos=corner_pos.sum(0).tolist(),
                   bounds=[corner_pos.min(0).tolist(), corner_pos.max(0).tolist()] if tris else None)
        names = [s.material.name for s in o.material_slots]
        out['tris_by_material'] = {names[i]: int((mat_idx == i).sum()) for i in sorted(set(mat_idx.tolist()))}
        for i, uv in enumerate(me.uv_layers[:2]):
            a = np.empty(len(me.loops) * 2, dtype=np.float64); uv.data.foreach_get('uv', a); a = a.reshape(-1, 2)[loops]
            # glTF stores v as 1 - v; record the sum in glTF convention
            out[f'uv{i}'] = [float(a[:, 0].sum()), float((1.0 - a[:, 1]).sum())]
            out[f'uv{i}_name'] = uv.name
        ca = me.color_attributes.get(COLOR)
        if ca is not None:
            c = np.empty(len(ca.data) * 4, dtype=np.float64); ca.data.foreach_get('color', c); c = c.reshape(-1, 4)
            c = c[loops] if ca.domain == 'CORNER' else c[vidx[loops]]
            out['color'] = c.sum(0).tolist()
            out['color_domain'] = ca.domain
            out['color_type'] = ca.data_type
        for name in ('_PROJ_X', '_PROJ_Y', '_PROJ_DEPTH'):
            a = me.attributes.get(name)
            if a is not None:
                v = np.empty(len(a.data), dtype=np.float64); a.data.foreach_get('value', v)
                out[name] = float(v[loops].sum())
        return out
    finally:
        ev.to_mesh_clear()


def mat_rows(m):
    return [[round(v, 7) for v in row] for row in m]


nodes, report_objects, problems = [], {}, []
for o in objects:
    r = role_of(o)
    zone = None
    for part in o.name.split('_'):
        if part in ('GF', 'F2', 'F3Roof'):
            zone = part
    wing = next((w for w in ('West', 'Centre', 'East') if f'_{w}_' in f'_{o.name}_'), None)
    e = dict(assetId=asset_id(o), sourceName=o.name, objectType=o.type, role=r,
             parent=asset_id(o.parent) if o.parent else None,
             openingId=o.get('openingId') or o.get('opening_id') or None,
             dynamicFace=o.get('dynamic_face') or None,
             assetZone=zone, modelWing=wing,
             floorLevel=None,            # database floor level: unknown until mapped and verified
             cutawayGroup=zone,          # provisional: zone name from the source object name
             classification='from-name-prefix',
             # model-space placement (glTF axes, column-major 4x4), read from the model, not a field survey
             worldGltf=[round(v, 6) for col in zip(*[list(r) for r in (R @ o.matrix_world)]) for v in col],
             props={k: o[k] for k in o.keys() if k not in ('assetId', 'sourceName') and isinstance(o[k], (str, int, float, bool))})
    if o.type == 'MESH':
        s = corner_sums(o)
        report_objects[o.name] = s
        e['triangles'] = s['triangles']
        e['boundsGltf'] = s['bounds']
        e['materials'] = [sl.material.name for sl in o.material_slots]
        uvn = [u.name for u in o.data.uv_layers]
        if not o.name.startswith('ENV_'):
            if uvn[:2] != [UV_BASE, UV_LIGHT]:
                problems.append(f'{o.name}: UV layers {uvn}, expected [{UV_BASE}, {UV_LIGHT}] first')
            if COLOR not in o.data.color_attributes:
                problems.append(f'{o.name}: no {COLOR} colour attribute')
    nodes.append(e)

if problems:
    fail('; '.join(problems[:20]) + (f' (+{len(problems) - 20} more)' if len(problems) > 20 else ''))

# ------------------------------------------------------------------ 6. viewpoints
vp_src = {}
for o in objects:
    if role_of(o) == 'viewpoint':
        kids = {c.name: c for c in o.children}
        t, u = kids.get(o.name + '_TARGET'), kids.get(o.name + '_UP')
        if not t or not u:
            fail(f'{o.name}: missing _TARGET/_UP child')
        tr = lambda v: list(R @ Vector(v))
        vp_src[o.name] = dict(marker=o.name, assetId=asset_id(o), targetAssetId=asset_id(t), upAssetId=asset_id(u),
                              blender=dict(position=list(o.matrix_world.translation), target=list(t.matrix_world.translation),
                                           up=list(u.matrix_world.translation)),
                              gltf=dict(position=tr(o.matrix_world.translation), target=tr(t.matrix_world.translation),
                                        up=tr(u.matrix_world.translation)))

# ------------------------------------------------------------------ 7. export
rna = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}


def opts(**kw):
    missing = [k for k in kw if k not in rna]
    if missing:
        fail(f'installed glTF exporter lacks options {missing}')
    return kw


common = opts(export_format='GLB', use_selection=True, use_active_scene=True, export_yup=True, export_apply=True,
              export_extras=True, export_texcoords=True, export_normals=True, export_tangents=False,
              export_materials='EXPORT', export_image_format='NONE', export_cameras=False, export_lights=False,
              export_animations=False, export_skins=False, export_morph=False,
              export_draco_mesh_compression_enable=False)
color_opts = {}
if 'export_vertex_color' in rna:
    items = {i.identifier for i in bpy.ops.export_scene.gltf.get_rna_type().properties['export_vertex_color'].enum_items}
    if 'NAME' in items and 'export_vertex_color_name' in rna:
        color_opts = dict(export_vertex_color='NAME', export_vertex_color_name=COLOR)
    elif 'ACTIVE' in items:
        color_opts = dict(export_vertex_color='ACTIVE')  # validated below: Albedo must be the active colour layer
        bad = [o.name for o in objects if o.type == 'MESH' and not o.name.startswith('ENV_')
               and (o.data.color_attributes.active_color is None or o.data.color_attributes.active_color.name != COLOR)]
        if bad:
            fail(f'ACTIVE colour mode but Albedo not active on {bad[:5]}')
    else:
        fail(f'no usable vertex colour export mode: {items}')
for k in ('export_all_vertex_colors', 'export_active_vertex_color_when_no_material'):
    if k in rna:
        color_opts[k] = False


def export(path, objs, **extra):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, **common, **extra)
    if not os.path.exists(path):
        fail(f'exporter wrote nothing to {path}')


building = [o for o in objects if not o.name.startswith('ENV_')]
export(os.path.join(OUT, 'building.glb'), building, **color_opts, **opts(export_attributes=False))
export(os.path.join(OUT, 'scenery.glb'), env, **opts(export_attributes=True, export_vertex_color='NONE') if 'export_vertex_color' in rna else opts(export_attributes=True))

# ------------------------------------------------------------------ 8. sidecars
json.dump(dict(schemaVersion=1, modelVersion=MODEL_VERSION, nodes=nodes), open(os.path.join(OUT, 'nodes.json'), 'w'), indent=1)
json.dump(dict(schemaVersion=1, modelVersion=MODEL_VERSION, viewpoints=vp_src), open(os.path.join(OUT, 'viewpoints.src.json'), 'w'), indent=1)
counts = {}
for n in nodes:
    counts[n['role']] = counts.get(n['role'], 0) + 1
json.dump(dict(schemaVersion=1, modelVersion=MODEL_VERSION, source=dict(file=os.path.basename(SRC), sha256=SRC_SHA, bytes=SRC_BYTES,
                                                                       scene=SCENE, collection=COLL),
               blender=bpy.app.version_string, exporter_options={**common, **color_opts},
               axis_conversion='gltf = (bx, bz, -by)', role_counts=counts, unknown_roles=unknown,
               mesh_objects=len(report_objects), building_mesh_objects=sum(1 for k in report_objects if not k.startswith('ENV_')),
               triangles=sum(v['triangles'] for v in report_objects.values()),
               building_triangles=sum(v['triangles'] for k, v in report_objects.items() if not k.startswith('ENV_')),
               materials=sorted(used), objects=report_objects),
          open(os.path.join(OUT, 'export-report.json'), 'w'), indent=1)
print('EXPORT_OK', len(objects), 'objects', sum(v['triangles'] for v in report_objects.values()), 'triangles', flush=True)
