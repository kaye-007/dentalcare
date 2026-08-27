/**
 * The one entry point that scripts/build-worker.mjs pre-bundles.
 *
 * Everything the Worker needs from the compiled Nest application is re-exported
 * here so the pre-bundle has a single root. See scripts/build-worker.mjs for
 * why the bundling is split in two.
 */
module.exports = {
  NestFactory: require('@nestjs/core').NestFactory,
  AppModule: require('../dist/app.module.js').AppModule,
  configureApp: require('../dist/bootstrap.js').configureApp,
  ReminderSchedulerService:
    require('../dist/modules/clinic/reminders/reminder-scheduler.service.js')
      .ReminderSchedulerService,
};
