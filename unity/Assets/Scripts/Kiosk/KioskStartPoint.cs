// Marks where the physical kiosk stands. Every route starts here.
// Its position comes from the database (admin panel ▸ Kiosks), so moving the kiosk
// to another spot in the lobby only needs a change in the admin panel.
using UnityEngine;

namespace CityHallKiosk
{
    public class KioskStartPoint : MonoBehaviour
    {
        public void Apply(DestinationRegistry reg)
        {
            if (reg.Kiosk == null) return;
            transform.position = reg.ToWorld(reg.Kiosk.Position);
            transform.rotation = reg.ToWorld(Quaternion.Euler(0f, reg.Kiosk.facing_deg, 0f));
        }

        void OnDrawGizmos()
        {
            Gizmos.color = new Color(0.18f, 0.49f, 0.20f);
            Gizmos.DrawCube(transform.position + Vector3.up * 0.9f, new Vector3(0.6f, 1.8f, 0.4f));
            Gizmos.DrawRay(transform.position + Vector3.up * 1.5f, transform.forward * 1.2f);
        }
    }
}
