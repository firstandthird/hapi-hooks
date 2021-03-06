const async = require('async');
const executeHook = require('./executeHook');
const hookStatus = require('./hookStatus');

module.exports = (server, settings, collection, allDone) => {
  let lastIntervalDate;
  async.autoInject({
    outstandingHooks(done) {
      // lastIntervalDate will be undefined the first time this is called:
      hookStatus(collection, lastIntervalDate, done);
    },
    logHooks(outstandingHooks, done) {
      server.emit('hook:query', outstandingHooks);

      if (settings.log) {
        server.log(['hapi-hooks', 'status'], outstandingHooks);
      }

      const proceed = outstandingHooks.processing === 0;

      if (!proceed && settings.log) {
        server.log(['hapi-hooks', 'warning'], `There are still ${outstandingHooks.processing} hooks in the queue.`);
      } else {
        lastIntervalDate = new Date();
      }

      done(null, proceed);
    },
    hooks(logHooks, done) {
      // don't process anything if there were still tasks processing
      if (!logHooks) {
        return done(null, []);
      }

      collection.find({
        status: {
          $in: ['waiting', 'failed']
        },
        runAfter: {
          $lte: new Date()
        }
      }).limit(settings.batchSize).toArray(done);
    },
    execute(hooks, done) {
      async.each(hooks, (hook, eachDone) => {
        server.emit('hook:start', hook);
        async.autoInject(executeHook(server, settings, collection, hook), eachDone);
      }, done);
    },
  }, (err, results) => {
    if (err) {
      return allDone(err);
    }

    return allDone(null, results.execute);
  });
};
