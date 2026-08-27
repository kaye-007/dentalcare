/**
 * Workers-safe replacement for `depd`.
 *
 * depd builds its deprecation wrappers with `new Function(...)`, and the
 * Workers runtime refuses code generation from strings: "EvalError: Code
 * generation from strings disallowed for this context". body-parser calls
 * deprecate.function() at module scope, so merely importing
 * @nestjs/platform-express threw before Nest could start.
 *
 * Everything depd does is print warnings about API shapes we are not using —
 * `bodyParser()` without a type, `res.send(status, body)`, and so on. Dropping
 * the warnings costs nothing at runtime; the wrapped function is returned
 * untouched, so behaviour is identical.
 *
 * The alternative is Express 5 (body-parser 2.x dropped depd), which means
 * NestJS 11. That is worth doing, and it is not a Cloudflare migration.
 */
module.exports = function depd(namespace) {
  function deprecate(_message) {}
  deprecate.function = function (fn, _message) {
    return fn;
  };
  deprecate.property = function (_obj, _prop, _message) {};
  deprecate._namespace = namespace;
  deprecate._ignored = true;
  deprecate._traced = false;
  deprecate._warned = Object.create(null);
  deprecate._file = undefined;
  return deprecate;
};
