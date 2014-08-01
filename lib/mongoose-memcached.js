/*jslint node:true nomen:true indent:2*/
'use strict';

/**
 * Module dependencies.
 */
var Memcached = require('memcached'),
  NodeStream = require('stream'),
  helpers = require('mongoose/lib/queryhelpers'),
  utils = require('mongoose/lib/utils'),
  Promise = require('mpromise'),
  model = require('./model');

/**
 * sets the function to generate the key
 * before you call this, make sure the query is a find query
 * @param {Query} query
 */
function genKeyFromQuery(query) {
  var obj = {};
  obj.model = query.model.modelName;
  obj.options = query.options;
  obj.cond = query._conditions;
  obj.fields = query._fields;
  obj.update = query._update;
  obj.path = query._path;
  obj.distinct = query._distinct;
  obj.populate = query._mongooseOptions.populate;
  return JSON.stringify(obj);
}

/**
 * Expose module.
 * @param {Object} Mongoose
 * @param {Object} options for the server such as cache and ttl
 */
module.exports = function mongooseMemcached(mongoose, options) {
  options = options || {};

  // default time to live in seconds
  var TTL = options.ttl || 60,
    CACHED = options.cache || false,
    memServer = options.memServers || 'localhost:11211',
    memOptions = options.memOptions || null,
    Query = mongoose.Query,
    Stream = mongoose.Stream,
    Model = mongoose.Model,
    exec = Query.prototype.exec,
    stream = Query.prototype.stream,
    geoNear = Model.geoNear,
    genKey = options.genKey || genKeyFromQuery,
    _memcached = new Memcached(memServer, memOptions);
  
  /**
   * Model.populate caching
  **/
  Model.populate = function (docs, paths, cb) {
    var promise = new Promise(cb);

    // always resolve on nextTick for consistent async behavior
    function resolve() {
      var args = utils.args(arguments);
      process.nextTick(function () {
        promise.resolve.apply(promise, args);
      });
    }

    // normalized paths
    var paths = utils.populate(paths);
    var pending = paths.length;

    if (0 === pending) {
      resolve(null, docs);
      return promise;
    }

    // each path has its own query options and must be executed separately
    var i = pending;
    var path;
    while (i--) {
      path = paths[i];
      model.populate(this, docs, path, next);
    }

    return promise;

    function next (err) {
      if (err) return resolve(err);
      if (--pending) return;
      resolve(null, docs);
    }
  }
  
  /**
   * geoNear cache enabler
   * @param {Object} GeoJSON
   * @param {Object} options
   * @param {Function} callback
   * @param {Boolean} cache
   * @param {Number} ttl
   * @param {String} key  identifier used for cache storage 
   * @return {Promise}
   * @api public
   */
  Model.geoNear = function (GeoJSON, options, callback) {
    callback = (typeof callback === 'function' ? callback : null);
    var offset = typeof callback === 'boolean' ? 2 : 3,
      cache = arguments[offset],
      ttl = arguments[offset + 1],
      key = arguments[offset + 2],
      self = this;
    
    if (cache) {
      key = key || JSON.stringify({ geo: GeoJSON, opts: options });
      // check in memcached. If not, then execute the query
      _memcached.get(key, function (e, data) {
         // if it does exist, return the data
        if (e) {
          return geoNear.call(self, GeoJSON, options, callback);
        } else if (data) {
          if (callback) {
            var arr = [],
              createAndEmit = function (promise, doc) {
                var instance = helpers.createModel(self, doc.obj, self._fields);
                instance.init(doc.obj, function (err) {
                  if (err) { return promise.reject(err); }
                  doc.obj = instance;
                  promise.fulfill(doc);
                });
              },
              // instanciation promise generator
              instantiate = function (doc) {
                // create promise
                var promise = new Promise();
                promise.onFulfill(function (arg) {
                  arr.push(arg);
                });
                if (options.lean) {
                  promise.fulfill(doc);
                } else {
                  createAndEmit(promise, doc);
                }
                return promise;
              },
              initialPromise,
              returnPromise,
              i,
              len;
            // chaining instantiation promises
            returnPromise = initialPromise = new Promise();
            for (i = 0, len = data.length; i < len; i += 1) {
              returnPromise = returnPromise.chain(instantiate(data[i]));
            }
            // on chain resolve
            returnPromise.onResolve(function (err) {
              if (err) {
                if (callback) { callback(err); }
                return;
              }
              if (callback) { callback(null, arr, true); }
            });
            // start chain
            initialPromise.fulfill();
            return;
          }
        }
        
        // if it does not exist, set the data after execution finished
        geoNear.call(self, GeoJSON, options, function (e, data) {
          if (e) {
            if (callback) { callback(e); }
            return;
          }
          // if it is not in memcached, set the key and return
          _memcached.set(key, data, ttl, function (e) {
            if (e) {
              if (callback) { callback(e); }
              return;
            }
            if (callback) {
              callback(null, data);
            }
          });
        });
      });
    } else {
      return geoNear.call(this, GeoJSON, options, callback);
    }
    return; //promise
  };
  
  /**
   * Cache enabler and disabler 
   * @param {Boolean} cache
   * @param {Number} ttl
   * @param {String} key  identifier used for cache storage 
   * @return {Query} this
   * @api public
   */
  Query.prototype.cache = function (cache, ttl, key) {

    // if you just call this function with no parameter, we are going to
    // assume the user want it cached, with the default ttl 
    if (!arguments.length) {
      this._cache = true;
    } else if ("boolean" === typeof cache) {
      this._cache = cache;
    }

    if ('number' === typeof ttl) {
      this._ttl = ttl;
    } else {
      this._ttl = TTL;
    }

    if ('string' === typeof key) {
      this._key = key;
    } else if('function' === typeof key) {
      this._key = key(this);
    } else {
      this._key = undefined;
    }

    return this;
  };

  /**
   * execution for the function
   * @param {Function} cb callback for the query 
   * @return {Query} this
   * @api public 
   */
  Query.prototype.exec = function (cb) {
    var self = this, key;
    
    // Modify population function
    self.model.populate = Model.populate;
    
    // initialize the value of _cache if .cache() was never called
    if (typeof self._cache === 'undefined') {
      self._cache = CACHED;
    }
    if (typeof self._ttl === 'undefined') {
      self._ttl = TTL;
    }
    // only cache find operations
    if (!self._cache || !(self.op === 'find' || self.op === 'findOne')) {
      self._dataCached = false;
      return exec.call(self, cb);
    }
    key = self._key || genKey(self);
    // check in memcached. If not, then execute the query
    _memcached.get(key, function (e, data) {
      // if it does exist, return the data
      if (e) {
        self._dataCached = false;
        return exec.call(self, cb);
      } else if (data) {
        var pop, opts = self._mongooseOptions, arr, createAndEmit, instanciate, initialPromise, returnPromise, i, len;
        if (opts.populate) { pop = helpers.preparePopulationOptionsMQ(self, opts); }

        if (Array.isArray(data)) {
          arr = [];
          createAndEmit = function (promise, doc) {
            var instance = helpers.createModel(self.model, doc, self._fields);
            instance.init(doc, function (err) {
              if (err) { return promise.reject(err); }
              promise.fulfill(instance);
            });
          };
          // instanciation promise generator
          instanciate = function (doc) {
            // create promise
            var promise = new Promise();
            promise.onFulfill(function (arg) {
              arr.push(arg);
            });
            // Check population
            if (!pop) {
              if (opts.lean) {
                promise.fulfill(doc);
              } else {
                createAndEmit(promise, doc);
              }
              return promise;
            }
            // Populate document
            self.model.populate(doc, pop, function (err, doc) {
              if (err) { return promise.reject(err); }
              return true === opts.lean ? promise.fulfill(doc) : createAndEmit(promise, doc);
            });
            return promise;
          };
          // chaining instanciation promises
          returnPromise = initialPromise = new Promise();
          for (i = 0, len = data.length; i < len; i += 1) {
            returnPromise = returnPromise.chain(instanciate(data[i]));
          }
          // on chain resolve
          returnPromise.onResolve(function (err) {
            if (err) {
              self._dataCached = false;
              return cb(err);
            }
            self._dataCached = true;
            cb(null, arr);
          });
          // start chain
          initialPromise.fulfill();
        } else {
          opts = self._mongooseOptions;
          if (opts.populate) { pop = helpers.preparePopulationOptionsMQ(self, opts); }
          
          createAndEmit = function (doc) {
            var instance = helpers.createModel(self.model, doc, self._fields);
            instance.init(doc, function (err) {
              if (err) {
                self._dataCached = false;
                return cb(err);
              }
              self._dataCached = true;
              cb(null, instance);
            });
          };
          
          // Check population
          if (!pop) {
            if (opts.lean) {
              cb(null, data);
            } else {
              createAndEmit(data);
            }
            return this;
          }
          // Populate document
          self.model.populate(data, pop, function (err, doc) {
            if (err) { return cb(err); }
            return true === opts.lean ? cb(null, doc) : createAndEmit(doc);
          });
        }
        return this;
      }

      // if it does not exist, set the data after execution finished
      exec.call(self, function (e, data) {
        if (e) {
          return cb(e);
        }
        // if it is not in memcached, set the key and return
        _memcached.set(key, data, self._ttl, function (e) {
          if (e) {
            return cb(e);
          }
          self._dataCached = false;
          return cb(null, data);
        });
      });
    });
    return this;
  };

  /**
   * execution for the stream function 
   * @param {Options} options 
   * @return {Stream}
   * @api public 
   */
  Query.prototype.stream = function (options) {
    var self = this, outStream = new NodeStream(), key;

    // initialize the value of _cache if .cache() was never called
    if (typeof self._cache === 'undefined') {
      self._cache = CACHED;
    }
    if (typeof self._ttl === 'undefined') {
      self._ttl = TTL;
    }
    // only cache find operations
    if (!self._cache || self.op !== 'find') {
      self._dataCached = false;
      return stream.call(self, options);
    }

    key = self._key || genKey(self);
    // check in memcached. If not, then execute the query
    _memcached.get(key, function (e, data) {
      var pop,
        opts = self._mongooseOptions,
        transform = options && 'function' === typeof options.transform ? options.transform : function (k) { return k; };

      function emit(doc) {
        outStream.emit('data', doc);
      }

      function createAndEmit(doc) {
        var instance = helpers.createModel(self.model, doc, self._fields);
        instance.init(doc, function (err) {
          if (err) { return self.destroy(err); }
          emit(instance);
        });
      }

      function processItem(doc) {
        if (self._destroyed) { return; }

        if (!pop) {
          return true === opts.lean ? emit(transform(doc)) : createAndEmit(doc);
        }

        self.model.populate(doc, pop, function (err, doc) {
          if (err) { return self.destroy(err); }
          return true === opts.lean ? emit(transform(doc)) : createAndEmit(doc);
        });
      }

      function emitData(items) {
        if (opts.populate) { pop = helpers.preparePopulationOptionsMQ(self, opts); }
        setTimeout(function () {
          items.forEach(processItem);
          outStream.emit('end');
          outStream.emit('close');
        }, 3);
        return outStream;
      }

      // if it does exist, return the data
      if (e) {
        self._dataCached = false;
        setTimeout(function () {
          outStream.emit('error', e);
        }, 3);
        return outStream;
      } else if (data) {
        self._dataCached = true;
        return emitData(data);
      }

      data = [];
      // if it does not exist, set the data after execution finished
      stream.call(self, options)
        .on('data', function (item) {
          data.push(item);
        })
        .on('error', function (e) {
          if (e) {
            return setTimeout(function () {
              outStream.emit('error', e);
            }, 3);
          }
        })
        .on('end', function () {
          // if it is not in memcached, set the key and return
          _memcached.set(key, data, self._ttl, function (e) {
            if (e) {
              return setTimeout(function () {
                outStream.emit('error', e);
              }, 3);
            }
            self._dataCached = false;
            setTimeout(function () {
              data.forEach(emit);
              outStream.emit('end');
              outStream.emit('close');
            }, 3);
          });
        });
    });
    return outStream;
  };

  /**
   * Check if results from this query is from cache.
   *
   * @type {Boolean}
   * @api public
   */
  Object.defineProperty(Query.prototype, 'isFromCache', {
    get: function () {
      return !(typeof this._dataCached === 'undefined' || this._dataCached === false);
    }
  });

  /**
   * Check if this query has caching enabled.
   *
   * @type {Boolean}
   * @api public
   */
  Object.defineProperty(Query.prototype, 'isCacheEnabled', {
    get: function () {
      return this._cache;
    }
  });
  
  // Init model with dependencies
  model.init(Model);
};

