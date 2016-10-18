const mongo = require('mongodb');
const async = require('async');
const _ = require('lodash');
const automap = require('automap');

exports.register = (server, options, next) => {
  const defaults = {
    mongo: {
      host: 'mongodb://localhost:27017',
      collectionName: 'hapi-activities'
    },
    timeout: 30 * 1000, // max time an action can take, default is 30 secs, set to false for infinity
    interval: 5 * 60 * 1000, // 5 minutes
    log: true
  };
  const settings = _.defaults(options, defaults);
  // connect to db:
  mongo.connect(settings.mongo.host, (err, db) => {
    if (err) {
      return next(err);
    }
    // initialize the server object:
    const collection = db.collection(settings.mongo.collectionName);

    // update all activities:
    const updateActivities = (allDone) => {
      automap(
        // fetch all 'waiting' activities and mark them as 'processing':
        (done) => {
          collection
          .find({ status: 'waiting' })
          .toArray((dbErr, results) => {
            if (dbErr) {
              server.log(['hapi-activities', 'error'], dbErr);
            }
            // can go back to sleep if nothing was found:
            if (results.length === 0) {
              return allDone();
            }
            // otherwise mark them all as 'processing' and proceed to process them:
            const ids = _.reduce(results, (memo, result) => {
              memo.push(result._id);
              return memo;
            }, []);
            collection.update({ _id: { $in: ids } }, { $set: { status: 'processing' } }, { multi: true }, () => {
              done(null, results);
            });
          });
        },
        // for each activity we just fetched and marked, do the following:
        (activity) => {
          return {
            // log that it's underway:
            logActivity: (done) => {
              if (settings.log) {
                server.log(['hapi-activities', 'starting-activity', 'debug'], { message: 'Processing underway for activity', data: activity });
              }
              done();
            },
            // execute the actions in parallel:
            performActions: ['logActivity', (results, done) => {
              // will launch the activity's actions in parallel:
              const updatedActivity = {
                results: []
              };
              async.each(settings.activities[activity.activityName], (action, eachDone) => {
                // if a timeout is specified then put a timeout wrapper around the server method call:
                const actionCall = settings.timeout ? async.timeout(server.methods[action], settings.timeout) : server.methods[action];
                actionCall(activity.activityData, (error, output) => {
                  // will log async's ETIMEDOUT error, as well as other errors for this action:
                  if (error) {
                    updatedActivity.results.push({ action, error });
                    updatedActivity.status = 'failed';
                  } else {
                    updatedActivity.results.push({ action, output });
                  }
                  eachDone();
                });
              }, () => {
                done(null, updatedActivity);
              });
            }],
            // mark the activity as either 'complete' or 'failed':
            completeActivity: ['performActions', (previous, done) => {
              const updatedActivity = {
                results: previous.performActions.results,
                // if any of the actions 'failed' then the activity status is 'failed':
                status: (previous.performActions.status === 'failed') ? 'failed' : 'complete',
                completedOn: new Date()
              };
              collection.update({ _id: activity._id }, { $set: updatedActivity }, (updateActivityError) => {
                if (updateActivityError) {
                  server.log(['hapi-activities', 'error'], updateActivityError);
                }
                done();
              });
            }]
          };
        },
      allDone);
    };
    // register the 'activity' method with the server:
    server.method('activity', (activityName, activityData) => {
      if (settings.log) {
        server.log(['hapi-activities', 'new-activity', 'debug'], { message: `Registering a new activity: '${activityName}'`, data: activityData });
      }
      collection.insertOne({
        activityName,
        activityData,
        status: 'waiting',
        added: new Date()
      }, (insertErr) => {
        if (insertErr) {
          server.log(insertErr);
        }
      });
    });

    // manage the interval polling:
    const timer = () => {
      updateActivities(() => {
        setTimeout(timer, settings.interval);
      });
    };
    timer();
    next();
  });
};

exports.register.attributes = {
  pkg: require('./package.json')
};