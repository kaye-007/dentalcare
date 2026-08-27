/**
 * Stand-in for nestjs-pino on Cloudflare Workers.
 *
 * pino-http reads `require('pino').symbols` at module scope. A Workers bundler
 * resolves pino through its "browser" field, and that build exports no
 * `symbols` — so merely importing nestjs-pino threw
 * "Cannot read properties of undefined (reading 'stringifySym')" before a
 * single line of application code ran. Pointing pino at its node build instead
 * only trades that for sonic-boom and thread-stream, which want file
 * descriptors and worker threads.
 *
 * AppModule never calls LoggerModule.forRoot() when RUNTIME=workers and
 * configureApp() never resolves the Logger token there, so nothing in this
 * module is ever touched on that runtime — stubbing it keeps pino, pino-http
 * and their dependencies out of the bundle entirely.
 */
module.exports = { LoggerModule: undefined, Logger: undefined };
