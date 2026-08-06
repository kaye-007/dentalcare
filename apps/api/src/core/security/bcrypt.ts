/**
 * Single source of truth for the bcrypt work factor.
 *
 * Was previously hardcoded as `10` at each of the four places that hash a
 * password (clinic login change, staff creation, tenant creation, seed), which
 * meant raising it required finding them all. Keep every hashing call site
 * pointed here.
 */
export const BCRYPT_ROUNDS = 10;
