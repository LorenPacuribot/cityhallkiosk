// Put one RoomMarker inside each room of the 3D model (name it DEST_<code>, e.g. DEST_1F-102).
//   • The marker's own position = room centre.
//   • Its child "Approach" (optional) = the spot in the corridor in front of the door.
//   • Its blue arrow (forward, +Z) = the direction the door faces.
// Then use  Kiosk ▸ Sync Room Markers → Server  to write the measured x/y/z into the database.
// From then on the admin panel shows the room as "Unity sync".
using UnityEngine;

namespace CityHallKiosk
{
    [ExecuteAlways]
    public class RoomMarker : MonoBehaviour
    {
        [Tooltip("Must match the room code in the admin panel, e.g. 1F-102")]
        public string roomCode;
        [Tooltip("Corridor point in front of the door. Created automatically if missing.")]
        public Transform approach;

        public Vector3 ApproachWorld => approach ? approach.position : transform.position;

        void OnValidate()
        {
            if (string.IsNullOrEmpty(roomCode) && name.StartsWith("DEST_")) roomCode = name.Substring(5);
        }

        public Transform EnsureApproach()
        {
            if (approach) return approach;
            var t = transform.Find("Approach");
            if (!t) { t = new GameObject("Approach").transform; t.SetParent(transform, false); t.localPosition = new Vector3(0, 0, 2f); }
            approach = t; return t;
        }

        /// <summary>Move this marker to the position stored in the database.</summary>
        public void ApplyFromServer(RoomDto r, DestinationRegistry reg)
        {
            transform.position = reg.ToWorld(r.Centre);
            transform.rotation = reg.ToWorld(r.DoorRotation);
            EnsureApproach().position = reg.ToWorld(r.Approach);
        }

        /// <summary>Read this marker as API coordinates (used by the editor sync).</summary>
        public RoomSyncItem ToSyncItem(DestinationRegistry reg)
        {
            Vector3 c = reg ? reg.ToApi(transform.position) : transform.position;
            Vector3 a = reg ? reg.ToApi(ApproachWorld) : ApproachWorld;
            Vector3 fwd = reg && reg.buildingRoot ? reg.buildingRoot.InverseTransformDirection(transform.forward) : transform.forward;
            float facing = Mathf.Repeat(Mathf.Atan2(fwd.x, fwd.z) * Mathf.Rad2Deg, 360f);
            return new RoomSyncItem
            {
                code = roomCode,
                x = Round(c.x), y = Round(c.y), z = Round(c.z),
                approach_x = Round(a.x), approach_y = Round(a.y), approach_z = Round(a.z),
                facing_deg = Mathf.Round(facing),
            };
        }
        static float Round(float v) => Mathf.Round(v * 100f) / 100f;

        void OnDrawGizmos()
        {
            Gizmos.color = new Color(0.72f, 0.26f, 0.18f, 0.9f); // terracotta
            Gizmos.DrawWireCube(transform.position + Vector3.up * 1.2f, new Vector3(1f, 2.4f, 1f));
            Gizmos.color = new Color(0.10f, 0.39f, 0.75f);     // brand blue
            Gizmos.DrawLine(transform.position, ApproachWorld);
            Gizmos.DrawSphere(ApproachWorld, 0.25f);
            Gizmos.DrawRay(transform.position + Vector3.up * 0.1f, transform.forward * 1.5f);
        }
    }
}
