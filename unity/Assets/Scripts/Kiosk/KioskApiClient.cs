// Thin HTTP client for the kiosk server. Coroutine-based so it works on every Unity
// version from 2021 LTS up without extra packages.
//
// Every GET response is also written to an offline cache (Application.persistentDataPath),
// so the 3D kiosk keeps working with the last known data if the network drops.
using System;
using System.Collections;
using System.IO;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace CityHallKiosk
{
    public class KioskApiClient : MonoBehaviour
    {
        public static KioskApiClient Instance { get; private set; }

        [Tooltip("Where the Node server runs. On the kiosk PC this is usually http://localhost:3000")]
        public string baseUrl = "http://localhost:3000";
        [Tooltip("Must match a kiosk code in the admin panel (Kiosks page).")]
        public string kioskCode = "KIOSK-LOBBY-1";
        public int timeoutSeconds = 8;

        public bool LastRequestWasOffline { get; private set; }

        void Awake()
        {
            if (Instance != null && Instance != this) { Destroy(gameObject); return; }
            Instance = this;
            DontDestroyOnLoad(gameObject);
        }

        // ------------------------------------------------------------ public API
        public IEnumerator GetVersion(Action<int> done) =>
            GetJson<VersionDto>("/api/kiosk/version", v => done(v?.content_version ?? -1), cache: false);

        public IEnumerator GetRooms(Action<RoomDto[]> done) =>
            GetJson<RoomList>("/api/rooms", r => done(r?.items ?? Array.Empty<RoomDto>()));

        public IEnumerator GetDestinations(Action<DestinationList> done) =>
            GetJson("/api/destinations", done);

        public IEnumerator GetFloors(Action<FloorDto[]> done) =>
            GetJson<FloorList>("/api/floors", r => done(r?.items ?? Array.Empty<FloorDto>()));

        public IEnumerator GetKiosk(Action<KioskDto> done) =>
            GetJson($"/api/kiosks/{UnityWebRequest.EscapeURL(kioskCode)}", done);

        /// <summary>Server-planned corridor route (fallback when there is no NavMesh). Also logs the navigation for analytics.</summary>
        public IEnumerator GetRoute(int roomId, Action<RouteDto> done) =>
            GetJson($"/api/route?room_id={roomId}&kiosk={UnityWebRequest.EscapeURL(kioskCode)}", done, cache: false);

        public IEnumerator Search(string query, Action<SearchResult> done) =>
            GetJson($"/api/search?q={UnityWebRequest.EscapeURL(query)}&kiosk={UnityWebRequest.EscapeURL(kioskCode)}", done, cache: false);

        public IEnumerator GetService(int id, Action<ServiceDto> done) =>
            GetJson($"/api/services/{id}", done);

        public IEnumerator Heartbeat(int contentVersion)
        {
            var body = "{\"app_version\":\"unity-" + Application.version + "\",\"content_version\":" + contentVersion + "}";
            yield return Send("POST", $"/api/kiosks/{UnityWebRequest.EscapeURL(kioskCode)}/heartbeat", body, null, (_, __) => { });
        }

        // ------------------------------------------------------------ plumbing
        public IEnumerator GetJson<T>(string path, Action<T> done, bool cache = true) where T : class
        {
            string text = null; bool ok = false;
            yield return Send("GET", path, null, null, (success, body) => { ok = success; text = body; });
            LastRequestWasOffline = !ok;
            if (ok && cache) OfflineCache.Write(path, text);
            if (!ok && cache) text = OfflineCache.Read(path);
            if (string.IsNullOrEmpty(text)) { done(null); yield break; }
            T result = null;
            try { result = JsonUtility.FromJson<T>(text); }
            catch (Exception e) { Debug.LogWarning($"[Kiosk] Could not read {path}: {e.Message}"); }
            done(result);
        }

        public IEnumerator Send(string method, string path, string jsonBody, string bearerToken, Action<bool, string> done)
        {
            using (var req = new UnityWebRequest(baseUrl.TrimEnd('/') + path, method))
            {
                req.downloadHandler = new DownloadHandlerBuffer();
                if (jsonBody != null)
                {
                    req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(jsonBody));
                    req.SetRequestHeader("Content-Type", "application/json");
                }
                if (!string.IsNullOrEmpty(bearerToken)) req.SetRequestHeader("Authorization", "Bearer " + bearerToken);
                req.timeout = timeoutSeconds;
                yield return req.SendWebRequest();
                bool ok = req.result == UnityWebRequest.Result.Success;
                if (!ok) Debug.LogWarning($"[Kiosk] {method} {path} failed: {req.error} {req.downloadHandler?.text}");
                done(ok, req.downloadHandler?.text);
            }
        }
    }

    /// <summary>Last good copy of each GET response, so the kiosk survives a network outage.</summary>
    public static class OfflineCache
    {
        static string Dir => Path.Combine(Application.persistentDataPath, "kiosk-cache");
        static string FileFor(string path)
        {
            var safe = new StringBuilder();
            foreach (var c in path) safe.Append(char.IsLetterOrDigit(c) ? c : '_');
            return Path.Combine(Dir, safe + ".json");
        }
        public static void Write(string path, string json)
        {
            try { Directory.CreateDirectory(Dir); File.WriteAllText(FileFor(path), json); }
            catch (Exception e) { Debug.LogWarning("[Kiosk] cache write failed: " + e.Message); }
        }
        public static string Read(string path)
        {
            try { var f = FileFor(path); return File.Exists(f) ? File.ReadAllText(f) : null; }
            catch { return null; }
        }
    }
}
