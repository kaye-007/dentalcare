/**
 * 0025 — sign-in lockout that holds everywhere, and one less grant
 *
 * ── Failed sign-ins ───────────────────────────────────────────────────────
 *
 * The only brake on password guessing was the in-memory throttle: ten tries
 * a minute, counted per process. On Workers every isolate counts for itself,
 * so the real limit was ten a minute times however many isolates the
 * attacker's requests landed on, and a slow guesser was never stopped at
 * all. There was no lockout except on the second factor.
 *
 * auth_throttle counts failures in the database, where every isolate and
 * every container replica sees the same number. A row is keyed by an HMAC
 * the API computes (scope plus account, or scope plus address), so the table
 * holds no email address and no IP. The API decides the limits; the table
 * only counts, locks and forgets.
 *
 * Nothing but three functions touches it. They run with their owner's
 * rights, so app_user holds EXECUTE on them and no privilege on the table:
 * a clinic session cannot read who was locked out, or unlock anyone.
 *
 *   auth_throttle_locked_until(keys)   the latest lock still in force, if any
 *   auth_throttle_fail(key, …)         count one failure; lock at the limit
 *   auth_throttle_clear(key)           forget an account after a sign-in
 *
 * ── tenants: INSERT revoked from app_user ─────────────────────────────────
 *
 * Only the platform plane creates clinics. Row-level security already made
 * the grant useless to a clinic (it could only insert its own id, which
 * exists), but a privilege nothing uses is one fewer thing to reason about.
 */

exports.shorthands = undefined;

const appUser = () => process.env.APP_DB_USER || 'app_user';

const UP = `
CREATE TABLE auth_throttle (
  key          text PRIMARY KEY,
  failures     integer NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  CONSTRAINT auth_throttle_key_shape CHECK (key ~ '^[a-z]+:[0-9a-f]{64}$'),
  CONSTRAINT auth_throttle_failures_sane CHECK (failures >= 0)
);

CREATE FUNCTION auth_throttle_locked_until(p_keys text[]) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT max(locked_until) FROM auth_throttle
   WHERE key = ANY (p_keys) AND locked_until > now()
$$;

CREATE FUNCTION auth_throttle_fail(
  p_key text, p_limit integer, p_window_minutes integer, p_lock_minutes integer
) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
  locked timestamptz;
BEGIN
  INSERT INTO auth_throttle AS t (key, failures, window_start)
  VALUES (p_key, 1, now())
  ON CONFLICT (key) DO UPDATE SET
    failures = CASE WHEN t.window_start < now() - make_interval(mins => p_window_minutes)
                    THEN 1 ELSE t.failures + 1 END,
    window_start = CASE WHEN t.window_start < now() - make_interval(mins => p_window_minutes)
                        THEN now() ELSE t.window_start END
  RETURNING failures INTO n;

  IF n >= p_limit THEN
    UPDATE auth_throttle
       SET locked_until = now() + make_interval(mins => p_lock_minutes),
           failures = 0, window_start = now()
     WHERE key = p_key
    RETURNING locked_until INTO locked;
  END IF;

  -- Forget what no longer matters, now and then, rather than on a schedule.
  IF random() < 0.01 THEN
    DELETE FROM auth_throttle
     WHERE coalesce(locked_until, window_start) < now() - interval '1 day';
  END IF;

  RETURN locked;
END $$;

CREATE FUNCTION auth_throttle_clear(p_key text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM auth_throttle WHERE key = p_key
$$;

REVOKE ALL ON TABLE auth_throttle FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_throttle_locked_until(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_throttle_fail(text, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_throttle_clear(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_throttle_locked_until(text[]) TO __APP_USER__;
GRANT EXECUTE ON FUNCTION auth_throttle_fail(text, integer, integer, integer) TO __APP_USER__;
GRANT EXECUTE ON FUNCTION auth_throttle_clear(text) TO __APP_USER__;

REVOKE INSERT ON TABLE tenants FROM __APP_USER__;
`;

const DOWN = `
GRANT INSERT ON TABLE tenants TO __APP_USER__;

DROP FUNCTION IF EXISTS auth_throttle_clear(text);
DROP FUNCTION IF EXISTS auth_throttle_fail(text, integer, integer, integer);
DROP FUNCTION IF EXISTS auth_throttle_locked_until(text[]);
DROP TABLE IF EXISTS auth_throttle;
`;

exports.up = (pgm) => {
  pgm.sql(UP.replace(/__APP_USER__/g, appUser()));
};

exports.down = (pgm) => {
  pgm.sql(DOWN.replace(/__APP_USER__/g, appUser()));
};
