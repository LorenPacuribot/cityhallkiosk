// "Show me the way" in 3D.
//
// 1. Start = the kiosk position from the database.  End = the room's door/approach point from the database.
// 2. If the City Hall model has a baked NavMesh, the path is NavMesh.CalculatePath (real walls, real stairs).
//    Otherwise (greybox / NavMesh not baked yet) it uses the server's corridor route from /api/route.
// 3. The path is drawn with a LineRenderer, a guide walks along it and the camera follows.
//
// Because both ends come from the database, moving an office in the admin panel changes the
// route on the next sync — no rebuild of the Unity app.
using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.AI;

namespace CityHallKiosk
{
    [RequireComponent(typeof(LineRenderer))]
    public class NavigationController : MonoBehaviour
    {
        [Header("Scene references")]
        [Tooltip("Optional. If empty, the kiosk position from the database is used.")]
        public KioskStartPoint startPoint;
        [Tooltip("The walking guide (a capsule or an animated character). Created automatically if empty.")]
        public Transform guide;
        [Tooltip("Camera that follows the guide. Leave empty to keep your own camera.")]
        public Camera followCamera;
        public Vector3 cameraOffset = new Vector3(0f, 14f, -12f);

        [Header("Behaviour")]
        public float previewSpeed = 4.5f;          // m/s — faster than a real walk so the preview is short
        public float lineHeight = 0.15f;
        public float navMeshSnapRadius = 2.5f;
        public bool preferNavMesh = true;

        public event Action<float> OnProgress;     // 0..1
        public event Action<string> OnStatus;      // human-readable status for the UI
        public event Action OnArrived;

        public bool IsNavigating { get; private set; }
        public bool Paused { get; set; }
        public RouteDto LastServerRoute { get; private set; }
        public string ActiveRoomCode { get; private set; }

        LineRenderer line;
        readonly List<Vector3> path = new List<Vector3>();
        float totalLength, travelled;
        int activeRoomId = -1;
        Vector3 activeTarget;

        void Awake()
        {
            line = GetComponent<LineRenderer>();
            line.positionCount = 0;
            if (line.sharedMaterial == null) line.material = new Material(Shader.Find("Sprites/Default"));
            line.startWidth = line.endWidth = 0.35f;
            line.startColor = line.endColor = new Color(0.10f, 0.39f, 0.75f);
            line.numCornerVertices = 4;
            if (!guide)
            {
                var g = GameObject.CreatePrimitive(PrimitiveType.Capsule);
                g.name = "Guide"; g.transform.localScale = new Vector3(0.6f, 0.9f, 0.6f);
                Destroy(g.GetComponent<Collider>());
                g.GetComponent<Renderer>().material.color = new Color(0.07f, 0.21f, 0.36f);
                guide = g.transform; guide.gameObject.SetActive(false);
            }
        }

        void Start() { if (DestinationRegistry.Instance) DestinationRegistry.Instance.OnChanged += HandleDataChanged; }
        void OnDestroy() { if (DestinationRegistry.Instance) DestinationRegistry.Instance.OnChanged -= HandleDataChanged; }

        // ------------------------------------------------------------ public
        public void NavigateToOffice(int officeId)
        {
            var d = DestinationRegistry.Instance.DestinationForOffice(officeId);
            if (d == null) { OnStatus?.Invoke("This office is not inside City Hall or its room is not set yet."); return; }
            NavigateToRoom(d.room_id);
        }

        public void NavigateToRoom(int roomId)
        {
            var reg = DestinationRegistry.Instance;
            var room = reg.RoomById(roomId);
            if (room == null) { OnStatus?.Invoke("Room not found."); return; }
            activeRoomId = roomId; ActiveRoomCode = room.code;
            activeTarget = reg.ToWorld(room.Approach);
            StopAllCoroutines();
            StartCoroutine(BuildAndPlay(roomId));
        }

        public void Replay() { travelled = 0f; Paused = false; if (path.Count > 1) IsNavigating = true; }
        public void Skip() { travelled = totalLength; }
        public void Stop()
        {
            StopAllCoroutines(); IsNavigating = false; activeRoomId = -1; ActiveRoomCode = null;
            line.positionCount = 0; if (guide) guide.gameObject.SetActive(false);
        }

        // ------------------------------------------------------------ path building
        IEnumerator BuildAndPlay(int roomId)
        {
            var reg = DestinationRegistry.Instance;
            Vector3 start = startPoint ? startPoint.transform.position : reg.KioskWorldPosition;
            path.Clear();

            if (preferNavMesh && TryNavMesh(start, activeTarget, path))
            {
                OnStatus?.Invoke("Route from the 3D model (NavMesh).");
                // still ask the server so the navigation is counted in the dashboard
                StartCoroutine(KioskApiClient.Instance.GetRoute(roomId, r => LastServerRoute = r));
            }
            else
            {
                RouteDto route = null;
                yield return KioskApiClient.Instance.GetRoute(roomId, r => route = r);
                LastServerRoute = route;
                if (route?.waypoints == null || route.waypoints.Length < 2)
                {
                    path.Add(start); path.Add(activeTarget); // last resort: straight line
                    OnStatus?.Invoke("Server route unavailable — showing direction only.");
                }
                else
                {
                    foreach (var w in route.waypoints) path.Add(reg.ToWorld(w.Position));
                    OnStatus?.Invoke("Route from the server (corridor plan). Bake a NavMesh for exact paths.");
                }
            }

            DrawLine();
            travelled = 0f; Paused = false; IsNavigating = true;
            guide.gameObject.SetActive(true);
        }

        bool TryNavMesh(Vector3 from, Vector3 to, List<Vector3> output)
        {
            if (!NavMesh.SamplePosition(from, out var a, navMeshSnapRadius, NavMesh.AllAreas)) return false;
            if (!NavMesh.SamplePosition(to, out var b, navMeshSnapRadius, NavMesh.AllAreas)) return false;
            var p = new NavMeshPath();
            if (!NavMesh.CalculatePath(a.position, b.position, NavMesh.AllAreas, p) || p.status != NavMeshPathStatus.PathComplete) return false;
            output.AddRange(p.corners);
            return output.Count > 1;
        }

        void DrawLine()
        {
            line.positionCount = path.Count;
            for (int i = 0; i < path.Count; i++) line.SetPosition(i, path[i] + Vector3.up * lineHeight);
            totalLength = 0f;
            for (int i = 1; i < path.Count; i++) totalLength += Vector3.Distance(path[i - 1], path[i]);
        }

        // ------------------------------------------------------------ playback
        void Update()
        {
            if (!IsNavigating || path.Count < 2) return;
            if (!Paused) travelled = Mathf.Min(totalLength, travelled + previewSpeed * Time.deltaTime);

            Vector3 pos = path[path.Count - 1], dir = Vector3.forward; float acc = 0f;
            for (int i = 1; i < path.Count; i++)
            {
                float seg = Vector3.Distance(path[i - 1], path[i]);
                if (acc + seg >= travelled || i == path.Count - 1)
                {
                    float t = seg > 0.001f ? Mathf.Clamp01((travelled - acc) / seg) : 1f;
                    pos = Vector3.Lerp(path[i - 1], path[i], t);
                    dir = path[i] - path[i - 1];
                    break;
                }
                acc += seg;
            }
            guide.position = pos + Vector3.up * 0.9f;
            dir.y = 0f;
            if (dir.sqrMagnitude > 0.001f) guide.rotation = Quaternion.Slerp(guide.rotation, Quaternion.LookRotation(dir), 10f * Time.deltaTime);

            if (followCamera)
            {
                Vector3 want = pos + cameraOffset;
                followCamera.transform.position = Vector3.Lerp(followCamera.transform.position, want, 1f - Mathf.Exp(-3f * Time.deltaTime));
                followCamera.transform.LookAt(pos + Vector3.up);
            }

            float progress = totalLength > 0 ? travelled / totalLength : 1f;
            OnProgress?.Invoke(progress);
            if (travelled >= totalLength) { IsNavigating = false; OnArrived?.Invoke(); }
        }

        // The admin moved an office/room while someone was looking → rebuild the route.
        void HandleDataChanged()
        {
            if (activeRoomId < 0) return;
            var room = DestinationRegistry.Instance.RoomById(activeRoomId);
            if (room == null) { Stop(); OnStatus?.Invoke("That room is no longer in use. Please search again."); return; }
            var newTarget = DestinationRegistry.Instance.ToWorld(room.Approach);
            if (Vector3.Distance(newTarget, activeTarget) > 0.05f) { OnStatus?.Invoke("Room position was updated — recalculating."); NavigateToRoom(activeRoomId); }
        }
    }
}
