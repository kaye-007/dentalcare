/**
 * 0019 — each practitioner's home room
 *
 * A room could be attached to every weekly shift ("usual room"), but nothing
 * read it: a new booking still started with no room, and a clinic that set
 * Monday-to-Friday up shift by shift had to pick the same chair five times
 * for no effect. In practice a dentist works from one chair.
 *
 * `home_operatory_id` is that chair. New bookings with the practitioner start
 * in it. Clearing it, or retiring the room, just means bookings start with no
 * room — nothing else depends on it.
 *
 * Starting value: the room most of the person's shifts already named.
 * staff_availability.operatory_id stays in place, no longer written by the UI.
 */

exports.shorthands = undefined;

const UP = `
ALTER TABLE users
  ADD COLUMN home_operatory_id uuid REFERENCES operatories(id) ON DELETE SET NULL;

UPDATE users u
   SET home_operatory_id = pick.operatory_id
  FROM (
    SELECT DISTINCT ON (a.staff_id) a.staff_id, a.operatory_id
      FROM staff_availability a
      JOIN operatories o ON o.id = a.operatory_id AND o.is_active
     WHERE a.operatory_id IS NOT NULL
     GROUP BY a.staff_id, a.operatory_id
     ORDER BY a.staff_id, count(*) DESC, a.operatory_id
  ) pick
 WHERE pick.staff_id = u.id;
`;

const DOWN = `ALTER TABLE users DROP COLUMN IF EXISTS home_operatory_id;`;

exports.up = (pgm) => {
  pgm.sql(UP);
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
