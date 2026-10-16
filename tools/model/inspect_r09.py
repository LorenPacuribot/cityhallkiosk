"""Read-only structural dump of the revision 09 runtime scene, for designing the web export.

  node tools/model/run-blender.mjs tools/model/inspect_r09.py -- <source.blend> <out.json>

Appends only scene UNITY_Baked_Optimized into an empty session (the source file is opened read-only
as a library and never saved). Writes object hierarchy, mesh attributes, UV/colour layers, material
slots, custom properties, projector UV ranges of ENV_ cards and the installed glTF exporter options.
"""
import bpy, json, sys, math

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = argv[0], argv[1]
SCENE, COLL = 'UNITY_Baked_Optimized', 'UNITY_Optimized_Geometry'

with bpy.data.libraries.load(SRC, link=False) as (src, dst):
    assert SCENE in src.scenes, f'missing scene {SCENE}: {src.scenes}'
    dst.scenes = [SCENE]
sc = bpy.data.scenes[SCENE]
coll = bpy.data.collections[COLL]

def props(idb):
    out = {}
    for k in idb.keys():
        if k.startswith('_'):
            continue
        v = idb[k]
        try:
            json.dumps(v); out[k] = v
        except TypeError:
            out[k] = str(v)
    return out

def mat(m):
    return [round(v, 6) for row in m for v in row]

def mesh_info(o):
    me = o.data
    me.calc_loop_triangles()
    info = dict(verts=len(me.vertices), loops=len(me.loops), polys=len(me.polygons), tris=len(me.loop_triangles),
                uv_layers=[u.name for u in me.uv_layers], active_uv=me.uv_layers.active.name if me.uv_layers.active else None,
                color_attributes=[dict(name=c.name, domain=c.domain, type=c.data_type) for c in me.color_attributes],
                active_color=me.color_attributes.active_color.name if me.color_attributes.active_color else None,
                attributes=sorted(a.name for a in me.attributes if not a.name.startswith('.')),
                materials=[s.material.name if s.material else None for s in o.material_slots],
                mesh_name=me.name, users=me.users)
    used = sorted({p.material_index for p in me.polygons})
    info['used_slots'] = used
    if o.name.startswith('ENV_'):
        rng = {}
        for u in me.uv_layers:
            xs = [d.uv[0] for d in u.data]; ys = [d.uv[1] for d in u.data]
            rng[u.name] = dict(x=[min(xs), max(xs)], y=[min(ys), max(ys)])
        info['uv_ranges'] = rng
    return info

objs = []
for o in sorted(coll.all_objects, key=lambda o: o.name):
    e = dict(name=o.name, type=o.type, parent=o.parent.name if o.parent else None,
             parent_type=o.parent_type if o.parent else None, children=len(o.children),
             collections=[c.name for c in o.users_collection], matrix_world=mat(o.matrix_world),
             hide_render=o.hide_render, props=props(o))
    if o.type == 'MESH':
        e['mesh'] = mesh_info(o)
    objs.append(e)

def walk(c, depth=0, acc=None):
    acc = [] if acc is None else acc
    acc.append(dict(name=c.name, depth=depth, objects=len(c.objects), all_objects=len(c.all_objects)))
    for ch in c.children:
        walk(ch, depth + 1, acc)
    return acc

materials = {}
for m in bpy.data.materials:
    nodes = [n.bl_idname for n in m.node_tree.nodes] if m.use_nodes and m.node_tree else []
    materials[m.name] = dict(users=m.users, nodes=nodes, props=props(m))

images = {i.name: dict(file=bpy.path.basename(i.filepath), packed=bool(i.packed_file), size=list(i.size),
                       colorspace=i.colorspace_settings.name) for i in bpy.data.images}

rna = bpy.ops.export_scene.gltf.get_rna_type()
exporter = {}
for p in rna.properties:
    if p.identifier == 'rna_type':
        continue
    d = dict(type=p.type)
    try:
        d['default'] = getattr(p, 'default_flag', None) if getattr(p, 'is_enum_flag', False) else p.default
    except Exception:
        pass
    if p.type == 'ENUM':
        d['items'] = [i.identifier for i in p.enum_items]
    exporter[p.identifier] = d
try:
    import addon_utils
    ver = [m.bl_info.get('version') for m in addon_utils.modules() if m.__name__ == 'io_scene_gltf2']
except Exception:
    ver = None

counts = {}
for o in objs:
    pre = o['name'].split('_')[0]
    counts[pre] = counts.get(pre, 0) + 1
tris = sum(o['mesh']['tris'] for o in objs if 'mesh' in o)
json.dump(dict(blender=bpy.app.version_string, gltf_addon=ver, scene=SCENE, collection=COLL,
               scene_collections=walk(sc.collection), prefix_counts=counts, mesh_objects=sum('mesh' in o for o in objs),
               triangles=tris, objects=objs, materials=materials, images=images, exporter=exporter,
               unit_scale=sc.unit_settings.scale_length, unit_system=sc.unit_settings.system),
          open(OUT, 'w'), indent=1)
print('INSPECT_OK', len(objs), 'objects', tris, 'triangles')
