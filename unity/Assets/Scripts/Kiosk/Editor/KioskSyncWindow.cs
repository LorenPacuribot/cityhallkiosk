// Kiosk ▸ Room Sync — the bridge between the Blender/Unity model and the database.
//
//  • "Push markers → server": reads every RoomMarker in the open scene and writes its x/y/z,
//    door point and facing into the rooms table (POST /api/admin/rooms/sync-from-unity).
//    Needs an LGU admin account. The rooms then show as "Unity sync" in the admin panel.
//  • "Pull server → markers": creates/moves DEST_<code> markers to the positions in the database.
//
// Uses blocking web requests on purpose: it is an editor tool, run by hand.
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;

namespace CityHallKiosk.EditorTools
{
    public class KioskSyncWindow : EditorWindow
    {
        string baseUrl = "http://localhost:3000";
        string email = "admin@kiosk.local";
        string password = "";
        string log = "";
        Vector2 scroll;

        [MenuItem("Kiosk/Room Sync…")]
        static void Open() => GetWindow<KioskSyncWindow>("Kiosk Room Sync");

        void OnEnable()
        {
            baseUrl = EditorPrefs.GetString("Kiosk.BaseUrl", baseUrl);
            email = EditorPrefs.GetString("Kiosk.Email", email);
        }

        void OnGUI()
        {
            EditorGUILayout.HelpBox("Positions are metres under the BuildingRoot: Y up, +X right when facing the building, +Z into the building, origin = main entrance.", MessageType.Info);
            baseUrl = EditorGUILayout.TextField("Server URL", baseUrl);
            email = EditorGUILayout.TextField("Admin email", email);
            password = EditorGUILayout.PasswordField("Password", password);
            var markers = FindObjectsOfType<RoomMarker>().Where(m => !string.IsNullOrEmpty(m.roomCode)).OrderBy(m => m.roomCode).ToArray();
            EditorGUILayout.LabelField($"Room markers in scene: {markers.Length}");

            using (new EditorGUILayout.HorizontalScope())
            {
                GUI.enabled = markers.Length > 0 && password.Length > 0;
                if (GUILayout.Button("Push markers → server", GUILayout.Height(30))) Push(markers);
                GUI.enabled = true;
                if (GUILayout.Button("Pull server → markers", GUILayout.Height(30))) Pull();
            }
            if (GUILayout.Button("Add RoomMarker to selected object") && Selection.activeGameObject)
            {
                var go = Selection.activeGameObject;
                var m = go.GetComponent<RoomMarker>();
                if (!m) m = Undo.AddComponent<RoomMarker>(go);
                if (go.name.StartsWith("DEST_")) m.roomCode = go.name.Substring(5);
                m.EnsureApproach();
            }

            EditorGUILayout.Space();
            scroll = EditorGUILayout.BeginScrollView(scroll);
            EditorGUILayout.TextArea(log, GUILayout.ExpandHeight(true));
            EditorGUILayout.EndScrollView();
        }

        void Push(RoomMarker[] markers)
        {
            EditorPrefs.SetString("Kiosk.BaseUrl", baseUrl); EditorPrefs.SetString("Kiosk.Email", email);
            var reg = FindObjectOfType<DestinationRegistry>();
            if (reg && !reg.buildingRoot) Log("Note: DestinationRegistry has no BuildingRoot — world coordinates are sent as-is.");

            var (ok, body) = Request("POST", "/api/auth/login", JsonUtility.ToJson(new LoginRequest { email = email, password = password }), null);
            if (!ok) { Log("Login failed: " + body); return; }
            var token = JsonUtility.FromJson<LoginResponse>(body).token;

            var payload = new RoomSyncRequest { items = markers.Select(m => m.ToSyncItem(reg)).ToArray() };
            (ok, body) = Request("POST", "/api/admin/rooms/sync-from-unity", JsonUtility.ToJson(payload), token);
            if (!ok) { Log("Sync failed: " + body); return; }
            var res = JsonUtility.FromJson<RoomSyncResponse>(body);
            Log($"Updated {res.updated?.Length ?? 0} rooms: {string.Join(", ", res.updated ?? new string[0])}");
            if (res.unknown != null && res.unknown.Length > 0)
                Log($"Unknown codes (add them in the admin panel first): {string.Join(", ", res.unknown)}");
            Request("POST", "/api/auth/logout", "{}", token);
        }

        void Pull()
        {
            var (ok, body) = Request("GET", "/api/rooms", null, null);
            if (!ok) { Log("Could not read rooms: " + body); return; }
            var rooms = JsonUtility.FromJson<RoomList>(body).items;
            var reg = FindObjectOfType<DestinationRegistry>();
            var parent = reg && reg.buildingRoot ? reg.buildingRoot : null;
            int created = 0, moved = 0;
            foreach (var r in rooms)
            {
                var m = FindObjectsOfType<RoomMarker>().FirstOrDefault(x => x.roomCode == r.code);
                if (!m)
                {
                    var go = new GameObject("DEST_" + r.code);
                    Undo.RegisterCreatedObjectUndo(go, "Create room marker");
                    if (parent) go.transform.SetParent(parent, false);
                    m = go.AddComponent<RoomMarker>(); m.roomCode = r.code; created++;
                }
                else moved++;
                Undo.RecordObject(m.transform, "Move room marker");
                Vector3 c = parent ? parent.TransformPoint(r.Centre) : r.Centre;
                Vector3 a = parent ? parent.TransformPoint(r.Approach) : r.Approach;
                m.transform.position = c;
                m.transform.rotation = (parent ? parent.rotation : Quaternion.identity) * r.DoorRotation;
                var ap = m.EnsureApproach(); Undo.RecordObject(ap, "Move approach"); ap.position = a;
                EditorUtility.SetDirty(m);
            }
            Log($"Pulled {rooms.Length} rooms: {created} markers created, {moved} moved. Now drag them to the real doors in the model and Push.");
        }

        (bool, string) Request(string method, string path, string json, string token)
        {
            using (var req = new UnityWebRequest(baseUrl.TrimEnd('/') + path, method))
            {
                req.downloadHandler = new DownloadHandlerBuffer();
                if (json != null) { req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(json)); req.SetRequestHeader("Content-Type", "application/json"); }
                if (token != null) req.SetRequestHeader("Authorization", "Bearer " + token);
                req.timeout = 10;
                var op = req.SendWebRequest();
                while (!op.isDone) { }
                return (req.result == UnityWebRequest.Result.Success, req.downloadHandler.text);
            }
        }

        void Log(string line) { log = $"[{System.DateTime.Now:HH:mm:ss}] {line}\n" + log; Repaint(); }
    }
}
