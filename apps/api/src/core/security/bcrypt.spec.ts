import * as bcrypt from 'bcryptjs';
import { BCRYPT_ROUNDS, NO_SUCH_ACCOUNT_HASH } from './bcrypt';

describe('NO_SUCH_ACCOUNT_HASH', () => {
  /**
   * An unknown address is compared against this so it costs the same bcrypt
   * work as a wrong password. If the work factor is raised and this is not,
   * a refusal for a missing account is measurably faster again.
   */
  it('costs exactly the work factor real passwords are hashed with', () => {
    expect(bcrypt.getRounds(NO_SUCH_ACCOUNT_HASH)).toBe(BCRYPT_ROUNDS);
  });

  it('matches none of the passwords someone would try', async () => {
    for (const guess of ['', 'password', 'Demo@2026!', '123456']) {
      expect(await bcrypt.compare(guess, NO_SUCH_ACCOUNT_HASH)).toBe(false);
    }
  });
});
