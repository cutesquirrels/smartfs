"use strict";

const events = require('events');
const levelup = require('levelup');

module.exports = function(path) {
  let db = levelup(path);
  let eventEmitter = new events.EventEmitter();

  return {
    on: eventEmitter.on.bind(eventEmitter),

    store: function(key, object, callback) {
      db.put(key, JSON.stringify(object), function(err) {
        if(err) {
          eventEmitter.emit('error', err);
        } else {
          callback(object);
        }
      });
    },

    load: function(callback) {
      let objects = [];
      db.createReadStream().
        on('data', function(item) {
          objects.push(JSON.parse(item.value));
        }).
        on('error', eventEmitter.emit.bind(eventEmitter, 'error')).
        on('end', function() {
          console.log('yielding', objects);
          callback(objects);
        });
    },

    loadItem: function(key, callback) {
      db.get(key, function(err, object) {
        if(err) {
          eventEmitter.emit('error', err);
        } else {
          callback(JSON.parse(object));
        }
      });
    }
  };
};
