/**
 * 0021 — panoramic and CBCT are kinds of their own
 *
 * Every radiograph was an "X-ray": the periapical taken in the chair, the
 * panoramic (OPG) from the clinic's own unit or a radiology centre, and the
 * CBCT a surgeon plans an implant on. A dentist looking for last year's
 * panoramic, to compare the bone, had to open each X-ray to find it — and the
 * upload already recognised "pano", "OPG" and "CBCT" in a file's name, only
 * to file them all as the same thing.
 *
 * 'xray' stays for intraoral radiographs (periapical, bitewing). Nothing
 * existing is re-labelled here: which of today's X-rays are panoramics is for
 * the clinic to say, one document at a time, not for a guess over file names.
 *
 * A CBCT is often a DICOM series or the imaging centre's PDF report; either
 * is stored as a file. There is no viewer for volumes, and none is planned.
 */

exports.shorthands = undefined;

const UP = `
ALTER TABLE patient_documents DROP CONSTRAINT patient_documents_kind_check;
ALTER TABLE patient_documents ADD CONSTRAINT patient_documents_kind_check CHECK (
  kind IN ('xray','panoramic','cbct','photo','consent','referral','insurance',
           'id_document','report','other'));
`;

// Panoramic and CBCT cannot be expressed before this migration; they become
// 'xray' again rather than blocking the rollback.
const DOWN = `
ALTER TABLE patient_documents NO FORCE ROW LEVEL SECURITY;
UPDATE patient_documents SET kind = 'xray' WHERE kind IN ('panoramic', 'cbct');
ALTER TABLE patient_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE patient_documents DROP CONSTRAINT patient_documents_kind_check;
ALTER TABLE patient_documents ADD CONSTRAINT patient_documents_kind_check CHECK (
  kind IN ('xray','photo','consent','referral','insurance','id_document','report','other'));
`;

exports.up = (pgm) => {
  pgm.sql(UP);
};

exports.down = (pgm) => {
  pgm.sql(DOWN);
};
