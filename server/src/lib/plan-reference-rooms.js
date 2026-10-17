// Rooms, office placements and doorway links from the owner's room guide (data/navigation/r09-room-guide.json).
// Called explicitly by setup tools (demo server, pilot screenshots, or an admin running it on purpose);
// never by application startup.
//
// - Room "N" of the guide becomes room code "Room N" on its floor, at its first doorway (draft position).
// - The office named for a room moves there (history kept, audited). An office named for a second room (City
//   Assessors: rooms 3 and 4) gets that room as an additional, non-primary location.
// - Each doorway listed for a room is linked to it as a DRAFT mapping (with its sign faces). Draft links show in
//   labelled staff previews; staff confirm them on site in Admin > Navigation before the public sees them.
// Re-running is safe: a room that already exists is left as it is, so later office moves are never undone.
import fs from 'node:fs';
import { get, run, tx, bumpContentVersion } from '../db.js';
import { audit } from '../auth.js';
import { officeLocation } from './data.js';

export const planReference = JSON.parse(fs.readFileSync(new URL('../../data/navigation/r09-room-guide.json', import.meta.url), 'utf8'));
export const roomCode = r => `Room ${r.number}`;

export function applyPlanReferenceRooms(graph) {
  if (graph.modelVersion !== planReference.modelVersion) throw new Error('The room guide belongs to another model.');
  const revision = get('SELECT id FROM navigation_revisions WHERE navigation_version = ?', [graph.navigationVersion]);
  if (!revision) throw new Error('Import the navigation graph first.');
  const applied = [];
  let relinked = 0;
  tx(() => {
    const seen = new Set(); // offices already placed by an earlier room in this run
    for (const ref of planReference.rooms) {
      const code = roomCode(ref);
      const existing = get('SELECT id FROM rooms WHERE code = ?', [code]);
      if (existing) {
        // already applied (offices stay where staff put them); a newer graph revision still needs this room's doorways,
        // linked as drafts only where that revision has no room yet
        for (const openingId of ref.openings) {
          const linked = run(`UPDATE room_openings SET room_id = ?, status = 'draft', notes = ? WHERE revision_id = ? AND opening_id = ? AND room_id IS NULL`,
            [existing.id, `Owner's room guide ${planReference.guideDate}: ${code}. ${ref.evidence}`, revision.id, openingId]).changes;
          if (linked) { run(`UPDATE sign_bindings SET status = 'draft' WHERE revision_id = ? AND opening_id = ? AND status <> 'verified'`, [revision.id, openingId]); relinked++; }
        }
        continue;
      }
      const floor = get('SELECT id FROM floors WHERE level = ?', [ref.level]);
      if (!floor) throw new Error(`No floor ${ref.level} for ${code}.`);
      const opening = graph.openings.find(o => o.openingId === ref.openings[0]);
      const approach = graph.nodes.find(n => n.id === opening?.approachNodeId);
      const door = opening?.doorPoint;
      if (ref.openings.length && (!door || !approach)) throw new Error(`The navigation graph has no approach for ${ref.openings[0]} (${code}).`);
      let office = ref.office ? get('SELECT id, name FROM offices WHERE short_name = ? AND is_active = 1', [ref.office]) : null;
      if (ref.office && !office && ref.officeName) { // an office the owner asked to add (e.g. Management Information System)
        office = get('SELECT id, name FROM offices WHERE name = ?', [ref.officeName]);
        if (!office) {
          const newId = run(`INSERT INTO offices(name, short_name, location_type) VALUES (?, ?, 'in_building')`, [ref.officeName, ref.office]).lastId;
          audit(null, 'create', 'office', newId, null, { name: ref.officeName, short_name: ref.office, source: planReference.source });
          office = { id: newId, name: ref.officeName };
        }
      }
      if (ref.office && !office) throw new Error(`Office ${ref.office} (${code}) is not in the database.`);
      const note = `Owner's room guide ${planReference.guideDate}: ${code}${office ? ` = ${office.name}` : ref.label ? ` = ${ref.label}` : ' (no office given)'}. ${ref.evidence}`;
      const name = office?.name || ref.label || code;
      const roomId = run(`INSERT INTO rooms(floor_id,code,name,room_type,x,y,z,approach_x,approach_y,approach_z,width_m,depth_m,coord_source,notes)
        VALUES (?,?,?,'office',?,?,?,?,?,?,1,1,'manual',?)`,
        [floor.id, code, name, door?.x ?? 0, door?.y ?? 0, door?.z ?? 0, approach?.x ?? null, approach?.y ?? null, approach?.z ?? null,
          `${note}${door ? ' Position = first doorway; room footprint not surveyed.' : ' No doorway on the main corridor; position not set.'}`]).lastId;
      if (office) {
        const before = officeLocation(office.id);
        if (!seen.has(office.id)) {
          run(`UPDATE office_locations SET valid_to = datetime('now') WHERE office_id = ? AND valid_to IS NULL`, [office.id]);
          run('INSERT INTO office_locations(office_id,room_id,note) VALUES (?,?,?)', [office.id, roomId, note]);
          run(`UPDATE offices SET location_type = 'in_building', updated_at = datetime('now') WHERE id = ?`, [office.id]);
          seen.add(office.id);
        } else {
          run('INSERT INTO office_locations(office_id,room_id,is_primary,note) VALUES (?,?,0,?)', [office.id, roomId, note]);
        }
        audit(null, 'room_guide', 'office', office.id, before, { ...officeLocation(office.id), room: code, source: note });
      }
      for (const openingId of ref.openings) {
        run(`UPDATE room_openings SET room_id = ?, status = 'draft', notes = ? WHERE revision_id = ? AND opening_id = ?`, [roomId, note, revision.id, openingId]);
        run(`UPDATE sign_bindings SET status = 'draft' WHERE revision_id = ? AND opening_id = ?`, [revision.id, openingId]);
      }
      applied.push(code);
    }
    // offices the guide marks "location unconfirmed" (only when the guide is first applied, so later placements stand)
    if (applied.length) for (const short of planReference.unconfirmed?.offices || []) {
      const office = get("SELECT id FROM offices WHERE short_name = ? AND is_active = 1 AND location_type = 'in_building'", [short]);
      if (!office) continue;
      const before = officeLocation(office.id);
      run(`UPDATE office_locations SET valid_to = datetime('now') WHERE office_id = ? AND valid_to IS NULL`, [office.id]);
      run(`UPDATE offices SET location_type = 'unconfirmed', updated_at = datetime('now') WHERE id = ?`, [office.id]);
      audit(null, 'room_guide', 'office', office.id, before, { ...officeLocation(office.id), source: planReference.unconfirmed.note });
    }
    if (applied.length || relinked) bumpContentVersion();
  });
  return applied;
}
