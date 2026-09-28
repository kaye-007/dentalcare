/**
 * Single source of truth for the bcrypt work factor.
 *
 * Was previously hardcoded as `10` at each of the four places that hash a
 * password (clinic login change, staff creation, tenant creation, seed), which
 * meant raising it required finding them all. Keep every hashing call site
 * pointed here.
 */
export const BCRYPT_ROUNDS = 10;

/**
 * Compared against when no account matches, so a sign-in for an address
 * nobody has costs the same bcrypt work as a wrong password, and the time a
 * refusal takes does not say which accounts exist. A hash of a random string
 * nobody kept; its cost must stay BCRYPT_ROUNDS (bcrypt.spec checks).
 */
export const NO_SUCH_ACCOUNT_HASH =
  '$2a$10$SE181HUKjmVmBFWN.gTlzOaB74xvTia8g4JTP79dQ8CM99IeMiDtS';
