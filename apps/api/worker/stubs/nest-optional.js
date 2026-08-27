/**
 * Stand-in for the Nest packages this application does not use.
 *
 * @nestjs/core calls require('@nestjs/websockets/socket-module') and
 * require('@nestjs/microservices') inside an optionalRequire() helper, and
 * guards every use of the result — a monolith speaking HTTP is expected to
 * have neither installed. Node is happy to let that require fail at runtime;
 * esbuild, which bundles ahead of time, is not, and refuses to build with an
 * unresolved specifier.
 *
 * Aliasing all three to this empty module turns "cannot resolve" back into the
 * "not installed" that Nest already handles: destructuring it yields
 * undefined, which is exactly the case those guards were written for.
 */
module.exports = {};
