// Initial draft placements from the user-supplied plans. Called explicitly by the demo/setup tool;
// never by application startup. Existing rooms/assignments are not overwritten on repeated runs.
import fs from 'node:fs';
import { get, run, tx, bumpContentVersion } from '../db.js';
import { audit } from '../auth.js';
import { officeLocation } from './data.js';

export const planReference = JSON.parse(fs.readFileSync(new URL('../../data/navigation/r09-plan-assignments.json', import.meta.url), 'utf8'));
export function applyPlanReferenceRooms(graph) {
  if (graph.modelVersion !== planReference.modelVersion) throw new Error('The reference belongs to another model.');
  const revision = get('SELECT id FROM navigation_revisions WHERE navigation_version = ?', [graph.navigationVersion]);
  if (!revision) throw new Error('Import the navigation graph first.');
  const applied = [];
  tx(() => {
    for (const ref of planReference.rooms) {
      if (get('SELECT id FROM rooms WHERE code = ?', [ref.code])) continue;
      const opening = graph.openings.find(o => o.openingId === ref.openingId);
      const approach = graph.nodes.find(n => n.id === opening?.approachNodeId);
      const door = opening?.doorPoint;
      const floor = get('SELECT id FROM floors WHERE level = ?', [ref.level]);
      const office = get('SELECT id FROM offices WHERE short_name = ? AND is_active = 1', [ref.officeShortName]);
      if (!door || !approach || !floor || !office) throw new Error(`Missing reference data for ${ref.code}.`);
      const note = `Draft from updated ${ref.plan} plan supplied ${planReference.referenceDate}: ${ref.planLabel}. ${ref.evidence} Door position from ${ref.openingId}; room footprint not surveyed.`;
      const roomId = run(`INSERT INTO rooms(floor_id,code,name,room_type,x,y,z,approach_x,approach_y,approach_z,width_m,depth_m,coord_source,notes)
        VALUES (?,?,?,'office',?,?,?,?,?,?,1,1,'manual',?)`, [floor.id, ref.code, ref.name, door.x, door.y, door.z, approach.x, approach.y, approach.z, note]).lastId;
      const before = officeLocation(office.id);
      run(`UPDATE office_locations SET valid_to = datetime('now') WHERE office_id = ? AND valid_to IS NULL`, [office.id]);
      run('INSERT INTO office_locations(office_id,room_id,note) VALUES (?,?,?)', [office.id, roomId, note]);
      run(`UPDATE offices SET location_type = 'in_building', updated_at = datetime('now') WHERE id = ?`, [office.id]);
      run(`UPDATE room_openings SET room_id = ?, status = 'draft', notes = ? WHERE revision_id = ? AND opening_id = ?`, [roomId, note, revision.id, ref.openingId]);
      run(`UPDATE sign_bindings SET status = 'draft' WHERE revision_id = ? AND opening_id = ?`, [revision.id, ref.openingId]);
      audit(null, 'plan_reference', 'office', office.id, before, { ...officeLocation(office.id), source: note });
      applied.push(ref.code);
    }
    if (applied.length) bumpContentVersion();
  });
  return applied;
}
