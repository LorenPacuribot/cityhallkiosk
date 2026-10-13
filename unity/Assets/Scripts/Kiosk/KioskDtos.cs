// Data shapes returned by the kiosk server (Node + SQLite).
// All positions are metres in Unity's own convention: Y up, +X right when facing the
// building, +Z into the building, origin = centre of the main entrance at ground level.
// So a value from the API can go straight into new Vector3(x, y, z) under the BuildingRoot.
using System;
using UnityEngine;

namespace CityHallKiosk
{
    [Serializable] public class VersionDto { public int content_version; }

    [Serializable]
    public class RoomDto
    {
        public int id;
        public string code;
        public string name;
        public string room_type;
        public int floor_level;
        public float x, y, z;
        public float approach_x, approach_y, approach_z;
        public float facing_deg;
        public float width_m, depth_m;
        public int is_accessible;
        public string coord_source;   // manual | unity_sync | seed_placeholder

        public Vector3 Centre => new Vector3(x, y, z);
        public Vector3 Approach => new Vector3(approach_x, approach_y, approach_z);
        public Quaternion DoorRotation => Quaternion.Euler(0f, facing_deg, 0f);
    }
    [Serializable] public class RoomList { public RoomDto[] items; }

    [Serializable]
    public class DestinationDto
    {
        public int office_id;
        public string office_name;
        public int room_id;
        public string room_code;
        public string room_name;
        public int floor_level;
        public string floor_name;
        public float x, y, z;
        public float approach_x, approach_y, approach_z;
        public float facing_deg;
        public string since;

        public Vector3 Approach => new Vector3(approach_x, approach_y, approach_z);
    }
    [Serializable] public class DestinationList { public int content_version; public DestinationDto[] items; }

    [Serializable]
    public class FloorDto
    {
        public int id;
        public int level;
        public string name;
        public float elevation_y;
        public float bounds_min_x, bounds_max_x, bounds_min_z, bounds_max_z;
        public RoomDto[] rooms;
    }
    [Serializable] public class FloorList { public FloorDto[] items; }

    [Serializable]
    public class KioskDto
    {
        public int id;
        public string code;
        public string name;
        public float x, y, z;
        public float facing_deg;
        public int floor_level;
        public Vector3 Position => new Vector3(x, y, z);
    }

    // /api/route — the server's corridor route. Used when no NavMesh is baked yet (greybox mode).
    [Serializable] public class WaypointDto { public float x, y, z; public int floor; public string label; public Vector3 Position => new Vector3(x, y, z); }
    [Serializable] public class DirectionDto { public string kind; public string key; public string text; public float distance_m; public int floor; public int point_index; }
    [Serializable] public class RouteEndDto { public int room_id; public string room_code; public string room_name; public int floor_level; public string floor_name; public float x, y, z; }
    [Serializable] public class RouteDto { public RouteEndDto to; public WaypointDto[] waypoints; public DirectionDto[] directions; public float distance_m; public float minutes; }

    // /api/search
    [Serializable] public class SearchHit { public string kind; public int id; public string title; public string subtitle; public float score; }
    [Serializable] public class SearchResult { public string query; public int count; public SearchHit[] results; }

    // /api/services/:id (subset used by the 3D app)
    [Serializable] public class RequirementDto { public int id; public string requirement; public string where_to_secure; }
    [Serializable] public class AgencyStepDto { public int id; public string agency_action; public string fee; public string processing_time; public string person_in_charge; }
    [Serializable] public class StepDto { public string client_action; public AgencyStepDto[] agency; }
    [Serializable] public class LocationDto { public string type; public string offsite_address; public int room_id; public string room_code; public string floor_name; public int floor_level; }
    [Serializable]
    public class ServiceDto
    {
        public int id; public int office_id; public string display_title; public string office_name;
        public string total_fees; public string total_processing_time; public string who_may_avail;
        public RequirementDto[] requirements; public StepDto[] steps; public LocationDto location;
    }

    // Editor → server coordinate sync (Kiosk > Sync Room Markers)
    [Serializable] public class LoginRequest { public string email; public string password; }
    [Serializable] public class LoginResponse { public string token; }
    [Serializable]
    public class RoomSyncItem
    {
        public string code;
        public float x, y, z;
        public float approach_x, approach_y, approach_z;
        public float facing_deg;
    }
    [Serializable] public class RoomSyncRequest { public RoomSyncItem[] items; }
    [Serializable] public class RoomSyncResponse { public string[] updated; public string[] unknown; }

    [Serializable] public class SessionLog { public string kiosk_code; public int navigated_room_id; }
}
