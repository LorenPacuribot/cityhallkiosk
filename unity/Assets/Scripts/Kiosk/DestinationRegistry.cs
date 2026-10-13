// Keeps the 3D scene in step with the database.
//
// Every `pollSeconds` it asks the server for the content version. When an admin moves an
// office to another room, or corrects a room's x/y/z, the version goes up and this script
// re-downloads rooms + destinations + the kiosk position and raises OnChanged.
// Nothing about room positions is hard-coded in the Unity scene.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace CityHallKiosk
{
    public class DestinationRegistry : MonoBehaviour
    {
        public static DestinationRegistry Instance { get; private set; }

        [Tooltip("Parent of the City Hall model. Its position is the main entrance (API origin). " +
                 "Leave empty if the model sits at world origin with the entrance at (0,0,0).")]
        public Transform buildingRoot;
        public float pollSeconds = 30f;

        [Tooltip("When ON, scene RoomMarkers are moved to the server positions after every sync. " +
                 "Turn OFF while you are placing markers by hand in the editor.")]
        public bool applyServerPositionsToMarkers = true;

        public int ContentVersion { get; private set; } = -1;
        public KioskDto Kiosk { get; private set; }
        public IReadOnlyList<RoomDto> Rooms => rooms;
        public IReadOnlyList<DestinationDto> Destinations => destinations;
        public bool IsOffline { get; private set; }

        /// <summary>Raised after every successful reload (first load included).</summary>
        public event Action OnChanged;

        readonly List<RoomDto> rooms = new List<RoomDto>();
        readonly List<DestinationDto> destinations = new List<DestinationDto>();
        readonly Dictionary<string, RoomDto> roomsByCode = new Dictionary<string, RoomDto>();

        void Awake() { Instance = this; }
        void Start() { StartCoroutine(PollLoop()); }

        IEnumerator PollLoop()
        {
            var api = KioskApiClient.Instance;
            while (api == null) { yield return null; api = KioskApiClient.Instance; }
            yield return Reload(); // first load (uses the offline cache if the server is down)
            while (true)
            {
                yield return new WaitForSeconds(pollSeconds);
                int v = -1;
                yield return api.GetVersion(x => v = x);
                IsOffline = v < 0;
                if (v >= 0 && v != ContentVersion) yield return Reload();
                yield return api.Heartbeat(ContentVersion);
            }
        }

        public IEnumerator Reload()
        {
            var api = KioskApiClient.Instance;
            DestinationList dest = null; RoomDto[] r = null; KioskDto k = null;
            yield return api.GetDestinations(x => dest = x);
            yield return api.GetRooms(x => r = x);
            yield return api.GetKiosk(x => k = x);
            IsOffline = api.LastRequestWasOffline;
            if (dest == null || r == null) { Debug.LogWarning("[Kiosk] No data from the server and no offline cache yet."); yield break; }

            ContentVersion = dest.content_version;
            destinations.Clear(); destinations.AddRange(dest.items ?? Array.Empty<DestinationDto>());
            rooms.Clear(); rooms.AddRange(r);
            roomsByCode.Clear(); foreach (var room in rooms) roomsByCode[room.code] = room;
            if (k != null) Kiosk = k;

            if (applyServerPositionsToMarkers) ApplyToMarkers();
            Debug.Log($"[Kiosk] Loaded content v{ContentVersion}: {rooms.Count} rooms, {destinations.Count} office destinations{(IsOffline ? " (OFFLINE cache)" : "")}.");
            OnChanged?.Invoke();
        }

        // ------------------------------------------------------------ lookups
        public RoomDto RoomByCode(string code) => code != null && roomsByCode.TryGetValue(code, out var r) ? r : null;
        public RoomDto RoomById(int id) => rooms.FirstOrDefault(r => r.id == id);
        public DestinationDto DestinationForOffice(int officeId) => destinations.FirstOrDefault(d => d.office_id == officeId);
        public IEnumerable<DestinationDto> Find(string text) =>
            destinations.Where(d => string.IsNullOrEmpty(text)
                || d.office_name.IndexOf(text, StringComparison.OrdinalIgnoreCase) >= 0
                || d.room_code.IndexOf(text, StringComparison.OrdinalIgnoreCase) >= 0);

        /// <summary>API metres → world position (respects where the BuildingRoot is placed).</summary>
        public Vector3 ToWorld(Vector3 apiPosition) => buildingRoot ? buildingRoot.TransformPoint(apiPosition) : apiPosition;
        public Vector3 ToApi(Vector3 worldPosition) => buildingRoot ? buildingRoot.InverseTransformPoint(worldPosition) : worldPosition;
        public Quaternion ToWorld(Quaternion apiRotation) => buildingRoot ? buildingRoot.rotation * apiRotation : apiRotation;

        public Vector3 KioskWorldPosition => Kiosk != null ? ToWorld(Kiosk.Position) : Vector3.zero;

        void ApplyToMarkers()
        {
            foreach (var m in FindObjectsOfType<RoomMarker>())
            {
                var r = RoomByCode(m.roomCode);
                if (r != null) m.ApplyFromServer(r, this);
            }
            foreach (var k in FindObjectsOfType<KioskStartPoint>()) k.Apply(this);
        }
    }
}
