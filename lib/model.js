/*jslint node:true nomen:true indent:2*/
'use strict';

var utils = require('mongoose/lib/utils');

module.exports.init = function (Model) {
  /*
    Functions here are ripped straight from mongoose/3.8.x/lib/model.js
    and slightly modified (row 140-146) to accomodate caching
  */
  
  /*!
  * Populates `docs`
  */

  module.exports.populate = function (model, docs, options, cb) {
    var select = options.select
    , match = options.match
    , path = options.path;

    var schema = model._getSchema(path);
    var subpath;

    // handle document arrays
    if (schema && schema.caster) {
      schema = schema.caster;
    }

    // model name for the populate query
    var modelName = options.model && options.model.modelName
    || options.model // query options
    || schema && schema.options && schema.options.ref // declared in schema
    || model.modelName; // an ad-hoc structure

    var Model = model.db.model(modelName);

    // expose the model used
    options.model = Model;

    // normalize single / multiple docs passed
    if (!Array.isArray(docs)) {
      docs = [docs];
    }

    if (0 === docs.length || docs.every(utils.isNullOrUndefined)) {
      return cb();
    }

    var rawIds = [];
    var i, doc, id;
    var len = docs.length;
    var ret;
    var found = 0;
    var isDocument;

    for (i = 0; i < len; i++) {
      ret = undefined;
      doc = docs[i];
      id = String(utils.getValue("_id", doc));
      isDocument = !! doc.$__;

      if (isDocument && !doc.isModified(path)) {
        // it is possible a previously populated path is being
        // populated again. Because users can specify matcher
        // clauses in their populate arguments we use the cached
        // _ids from the original populate call to ensure all _ids
        // are looked up, but only if the path wasn't modified which
        // signifies the users intent of the state of the path.
        var populated = doc.populated(path);
        if (Array.isArray(populated) && Array.isArray(doc.get(path)) && populated.length != doc.get(path).length) {
        } else {
          ret = populated;
        }
      }

      if (!ret || Array.isArray(ret) && 0 === ret.length) {
        ret = utils.getValue(path, doc);
      }

      if (ret) {
        ret = convertTo_id(ret);

        // previously we always assigned this even if the document had no _id
        options._docs[id] = Array.isArray(ret)
        ? ret.slice()
        : ret;
      }

      // always retain original values, even empty values. these are
      // used to map the query results back to the correct position.
      rawIds.push(ret);

      if (isDocument) {
        // cache original populated _ids and model used
        doc.populated(path, options._docs[id], options);
      }
    }

    var ids = utils.array.flatten(rawIds, function (item) {
      // no need to include undefined values in our query
      return undefined !== item;
    });

    if (0 === ids.length || ids.every(utils.isNullOrUndefined)) {
      return cb();
    }

    // preserve original match conditions by copying
    if (match) {
      match = utils.object.shallowCopy(match);
    } else {
      match = {};
    }

    match._id || (match._id = { $in: ids });

    var assignmentOpts = {};
    assignmentOpts.sort = options.options && options.options.sort || undefined;
    assignmentOpts.excludeId = /\s?-_id\s?/.test(select) || (select && 0 === select._id);

    if (assignmentOpts.excludeId) {
      // override the exclusion from the query so we can use the _id
      // for document matching during assignment. we'll delete the
      // _id back off before returning the result.
      if ('string' == typeof select) {
        select = select.replace(/\s?-_id\s?/g, ' ');
      } else {
        // preserve original select conditions by copying
        select = utils.object.shallowCopy(select);
        delete select._id;
      }
    }

    // if a limit option is passed, we should have the limit apply to *each*
    // document, not apply in the aggregate
    if (options.options && options.options.limit) {
      options.options.limit = options.options.limit * len;
    }
    
    var query = Model.find(match, select, options.options);
    if (options.options) { 
      if(options.options.cache) {
        query.cache(options.options.cache, options.options.ttl, options.options.key);
      }
    }
    query.exec(function (err, vals) {
      if (err) return cb(err);
      
      var lean = options.options && options.options.lean;
      var len = vals.length;
      var rawOrder = {};
      var rawDocs = {}
      var key;
      var val;

      // optimization:
      // record the document positions as returned by
      // the query result.
      for (var i = 0; i < len; i++) {
        val = vals[i];
        key = String(utils.getValue('_id', val));
        rawDocs[key] = val;
        rawOrder[key] = i;

        // flag each as result of population
        if (!lean) val.$__.wasPopulated = true;
      }

      assignVals({
        rawIds: rawIds,
        rawDocs: rawDocs,
        rawOrder: rawOrder,
        docs: docs,
        path: path,
        options: assignmentOpts
      });

      cb();
    });
  }

  /*!
* Retrieve the _id of `val` if a Document or Array of Documents.
*
* @param {Array|Document|Any} val
* @return {Array|Document|Any}
*/

  function convertTo_id (val) {
    if (val instanceof Model) return val._id;

    if (Array.isArray(val)) {
      for (var i = 0; i < val.length; ++i) {
        if (val[i] instanceof Model) {
          val[i] = val[i]._id;
        }
      }
      return val;
    }

    return val;
  }

  /*!
* Assigns documents returned from a population query back
* to the original document path.
*/

  function assignVals (o) {
    // replace the original ids in our intermediate _ids structure
    // with the documents found by query

    assignRawDocsToIdStructure(o.rawIds, o.rawDocs, o.rawOrder, o.options);

    // now update the original documents being populated using the
    // result structure that contains real documents.

    var docs = o.docs;
    var path = o.path;
    var rawIds = o.rawIds;
    var options = o.options;

    for (var i = 0; i < docs.length; ++i) {
      utils.setValue(path, rawIds[i], docs[i], function (val) {
        return valueFilter(val, options);
      });
    }
  }

  /*!
* 1) Apply backwards compatible find/findOne behavior to sub documents
*
* find logic:
* a) filter out non-documents
* b) remove _id from sub docs when user specified
*
* findOne
* a) if no doc found, set to null
* b) remove _id from sub docs when user specified
*
* 2) Remove _ids when specified by users query.
*
* background:
* _ids are left in the query even when user excludes them so
* that population mapping can occur.
*/

  function valueFilter (val, assignmentOpts) {
    if (Array.isArray(val)) {
      // find logic
      var ret = [];
      for (var i = 0; i < val.length; ++i) {
        var subdoc = val[i];
        if (!isDoc(subdoc)) continue;
        maybeRemoveId(subdoc, assignmentOpts);
        ret.push(subdoc);
      }
      return ret;
    }

    // findOne
    if (isDoc(val)) {
      maybeRemoveId(val, assignmentOpts);
      return val;
    }

    return null;
  }

  /*!
* Remove _id from `subdoc` if user specified "lean" query option
*/

  function maybeRemoveId (subdoc, assignmentOpts) {
    if (assignmentOpts.excludeId) {
      if ('function' == typeof subdoc.setValue) {
        delete subdoc._doc._id;
      } else {
        delete subdoc._id;
      }
    }
  }

  /*!
* Determine if `doc` is a document returned
* by a populate query.
*/

  function isDoc (doc) {
    if (null == doc)
      return false;

    var type = typeof doc;
    if ('string' == type)
      return false;

    if ('number' == type)
      return false;

    if (Buffer.isBuffer(doc))
      return false;

    if ('ObjectID' == doc.constructor.name)
      return false;

    // only docs
    return true;
  }

  /*!
* Assign `vals` returned by mongo query to the `rawIds`
* structure returned from utils.getVals() honoring
* query sort order if specified by user.
*
* This can be optimized.
*
* Rules:
*
* if the value of the path is not an array, use findOne rules, else find.
* for findOne the results are assigned directly to doc path (including null results).
* for find, if user specified sort order, results are assigned directly
* else documents are put back in original order of array if found in results
*
* @param {Array} rawIds
* @param {Array} vals
* @param {Boolean} sort
* @api private
*/

  function assignRawDocsToIdStructure (rawIds, resultDocs, resultOrder, options, recursed) {
    // honor user specified sort order
    var newOrder = [];
    var sorting = options.sort && rawIds.length > 1;
    var found;
    var doc;
    var sid;
    var id;

    for (var i = 0; i < rawIds.length; ++i) {
      id = rawIds[i];

      if (Array.isArray(id)) {
        // handle [ [id0, id2], [id3] ]
        assignRawDocsToIdStructure(id, resultDocs, resultOrder, options, true);
        newOrder.push(id);
        continue;
      }

      if (null === id && !sorting) {
        // keep nulls for findOne unless sorting, which always
        // removes them (backward compat)
        newOrder.push(id);
        continue;
      }

      sid = String(id);
      found = false;

      if (recursed) {
        // apply find behavior

        // assign matching documents in original order unless sorting
        doc = resultDocs[sid];
        if (doc) {
          if (sorting) {
            newOrder[resultOrder[sid]] = doc;
          } else {
            newOrder.push(doc);
          }
        } else {
          newOrder.push(id);
        }
      } else {
        // apply findOne behavior - if document in results, assign, else assign null
        newOrder[i] = doc = resultDocs[sid] || null;
      }
    }

    rawIds.length = 0;
    if (newOrder.length) {
      // reassign the documents based on corrected order

      // forEach skips over sparse entries in arrays so we
      // can safely use this to our advantage dealing with sorted
      // result sets too.
      newOrder.forEach(function (doc, i) {
        rawIds[i] = doc;
      });
    }
  }
};