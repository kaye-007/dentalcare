/**
 * 0018 — who sees patients, separately from what they may do
 *
 * The calendar gave a column to every administrator, dentist and hygienist,
 * so a clinic that wanted its dentists on the calendar made them all
 * administrators — with the run of settings, staff and money — and an owner
 * who never treats anyone still got an empty column. Access (role) and job
 * (sees patients) were one setting doing two jobs.
 *
 * `sees_patients` is the job half: this person has a calendar column, a
 * weekly schedule and appointments in their name. The role stays what it
 * always was, what they may do.
 *
 * Starting values: dentists and hygienists see patients; an administrator
 * does if appointments have ever been booked with them. Everyone else not.
 */

exports.shorthands = undefined;

const appUser = () => process.env.APP_DB_USER || 'app_user';

const UP = `
ALTER TABLE users ADD COLUMN sees_patients boolean NOT NULL DEFAULT false;

UPDATE users u
   SET sees_patients = true
 WHERE u.role IN ('dentist','hygienist')
    OR (u.role = 'admin' AND EXISTS (SELECT 1 FROM appointments a WHERE a.staff_id = u.id));

GRANT UPDATE (sees_patients) ON TABLE users TO __APP_USER__;
`;

const DOWN = `ALTER TABLE users DROP COLUMN IF EXISTS sees_patients;`;

exports.up = (pgm) => {
  pgm.sql(UP.replace(/__APP_USER__/g, appUser()));
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
