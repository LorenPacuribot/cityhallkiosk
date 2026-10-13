// Builds a simple block model of City Hall from the database (floors + rooms with x/y/z),
// so the 3D navigation can be tested before the real Blender model is imported.
// It rebuilds itself whenever the data changes. Disable this component once the real model is in.
using System.Collections.Generic;
using UnityEngine;

namespace CityHallKiosk
{
    public class GreyboxBuilder : MonoBehaviour
    {
        public bool buildOnDataChange = true;
        public float wallHeight = 2.6f;
        [Range(0f, 1f)] public float roomAlpha = 0.85f;
        public bool createRoomMarkers = true;

        readonly List<GameObject> built = new List<GameObject>();

        void Start()
        {
            if (DestinationRegistry.Instance) DestinationRegistry.Instance.OnChanged += Rebuild;
        }
        void OnDestroy()
        {
            if (DestinationRegistry.Instance) DestinationRegistry.Instance.OnChanged -= Rebuild;
        }

        public void Rebuild()
        {
            if (!buildOnDataChange) return;
            StartCoroutine(BuildRoutine());
        }

        System.Collections.IEnumerator BuildRoutine()
        {
            FloorDto[] floors = null;
            yield return KioskApiClient.Instance.GetFloors(f => floors = f);
            if (floors == null) yield break;
            foreach (var go in built) if (go) Destroy(go);
            built.Clear();

            var reg = DestinationRegistry.Instance;
            var parent = reg.buildingRoot ? reg.buildingRoot : transform;
            foreach (var f in floors)
            {
                var floorGo = new GameObject($"Floor {f.level} ({f.name})");
                floorGo.transform.SetParent(parent, false);
                built.Add(floorGo);

                float w = f.bounds_max_x - f.bounds_min_x, d = f.bounds_max_z - f.bounds_min_z;
                var slab = Block(floorGo.transform, "Slab", new Vector3(f.bounds_min_x + w / 2, f.elevation_y - 0.15f, f.bounds_min_z + d / 2),
                                 new Vector3(w, 0.3f, d), new Color(0.95f, 0.94f, 0.91f), 1f);
                slab.isStatic = true; // include in NavMesh bake

                foreach (var r in f.rooms)
                {
                    bool flat = r.room_type == "hall" || r.room_type == "entrance" || r.room_type == "corridor";
                    float h = flat ? 0.05f : r.room_type == "stairs" ? 1.2f : wallHeight;
                    Color c = r.room_type == "office" ? new Color(0.79f, 0.88f, 0.97f)
                            : r.room_type == "stairs" ? new Color(0.85f, 0.65f, 0.13f)
                            : r.room_type == "toilet" ? new Color(0.90f, 0.95f, 0.91f)
                            : new Color(0.89f, 0.87f, 0.83f);
                    var box = Block(floorGo.transform, $"{r.code} {r.name}", new Vector3(r.x, r.y + h / 2, r.z),
                                    new Vector3(r.width_m > 0 ? r.width_m : 4, h, r.depth_m > 0 ? r.depth_m : 4), c, flat ? 1f : roomAlpha);
                    box.transform.localRotation = Quaternion.Euler(0, r.facing_deg, 0);

                    if (createRoomMarkers && r.room_type != "hall")
                    {
                        var m = new GameObject("DEST_" + r.code).AddComponent<RoomMarker>();
                        m.roomCode = r.code;
                        m.transform.SetParent(floorGo.transform, false);
                        m.ApplyFromServer(r, reg);
                    }
                }
            }
        }

        static GameObject Block(Transform parent, string name, Vector3 localPos, Vector3 size, Color color, float alpha)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.name = name;
            go.transform.SetParent(parent, false);
            go.transform.localPosition = localPos;
            go.transform.localScale = size;
            var mr = go.GetComponent<Renderer>();
            var mat = new Material(Shader.Find("Standard") ?? Shader.Find("Universal Render Pipeline/Lit"));
            color.a = alpha;
            mat.color = color;
            mr.material = mat;
            return go;
        }
    }
}
