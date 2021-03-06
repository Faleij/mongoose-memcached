'use strict';

var Memcached = require('memcached'); 
var mongooseMemcached = require('../'),
    mongoose = require('mongoose'),
    Schema = mongoose.Schema,
    ObjectId = mongoose.Types.ObjectId,
    PeopleSchema,
    People,
    _memcached,
    expect = require('expect.js'),
    names = [
      "Jacob","Sophia", "Mason", "Isabella", "William", "Emma", "Jayden",
      "Olivia", "Noah", "Ava", "Michael", "Emily", "Ethan", "Abigail",
      "Alexander", "Madison", "Aiden", "Mia", "Daniel", "Chloe"
    ],
    db;


describe('mongoose-memcached', function() {
  before(function(done) {
    // connecting to mongoose
    mongoose.connect('mongodb://127.0.0.1/mongoose-cachebox-testing');

    db = mongoose.connection;

    db.on('error', function (err) {
      done(err);
    });

    db.once('open', done);

    // adding mongoose cachebox
    // I set the port on 11212 because of old habit.
    mongooseMemcached(mongoose, {memServers: "localhost:11212"});
    _memcached = new Memcached('localhost:11212');
    PeopleSchema = new Schema({
      name: String,
      date: {
        type: String,
        "default": Date.now()
      },
      num: Number,
      test: Boolean,
      peer: { type: Schema.Types.ObjectId, ref: 'People' }
    });

    People = mongoose.model('People', PeopleSchema);
  });

  function generate (amount, fn) {
    var crowd = [];
    var count = 0;
    var id = ObjectId(), prevId;
    while (count < amount) {
      prevId = id;
      id = ObjectId();
      crowd.push({
        _id: id,
        name: names[Math.floor(Math.random() * names.length)],
        num: Math.random() * 10000,
        peer: prevId
      });
      count++;
    }
    crowd[0].peer = crowd[count - 1]._id;
    
    People.create(crowd, fn);
  }


  beforeEach(function(done){
    _memcached.flush(function(e) {
      if(e) {
        return done(e);
      }
      generate(10, done);
    });
  });

  afterEach(function(done){
    People.remove(done);
  });  

  it('should have `cache` method', function () {
    expect(People.find({}).cache).to.be.a('function');
  });

  it('should not cache query if .cache method is not called', function (done) {
    var query = People.find({});
    query.exec(function (err, docs) {
      if (err) {
        return done(err);
      }
      query = People.find({});
      query.exec(function (err, docs) {
        if (err) {
          return done(err);
        }
        if (docs) {
          expect(query.isFromCache).to.be(false);
          done();
        }
      });
    });
  });

  it('should cache query if the `cache` method is called', function (done) {
    var self = this;
    var query = People.find({});
    query.cache(true, 2).exec(function (err, docs) {
      var time = Date.now();
      if (err) {
        return done(err);
      }
      People.find({}).exec(function (err, docs) {
        if (err) {
          return done(err);
        }
        People.find({}).exec(function (err, docs) {
          if (err) {
            return done(err);
          }
          People.find({}).exec(function (err, docs) {
          if (err) {
              return done(err);
            }
            People.find({}).exec(function (err, docs) {
              if (err) {
                return done(err);
              }
              var docsOrg = docs.map(function (doc) { return doc.toObject(); });
              query = People.find({}).cache().exec(function (err, docs) {
                if (err) {
                  return done(err);
                }
                if (docs) {
                  time = Date.now() - time;
                  expect(docs).to.be.ok();
                  expect(query.isFromCache).to.be(true);
                  expect(docs[0].save).to.be.a('function');
                  expect(docsOrg).to.eql(docs.map(function (doc) { return doc.toObject(); }));
                  done();
                }
              });
            });
          });
        });
      });
    });
  });
  
  it('should cache model.populate if cache option is used', function (done) {
    var query = People.findOne({});
    query.cache(true, 2);
    query.populate({ path: 'peer', options: { cache: true, ttl: 2 } });
    query.exec(function (err, doc) {
      if (err) {
        return done(err);
      }
      expect(query.isFromCache).to.be(false);
      expect(doc.peer).to.be.ok();
      expect(doc.peer).to.be.a('object');
      var peer = doc.peer;
      query = People.findOne({});
      query.populate({ path: 'peer', options: { cache: true, ttl: 2 } });
      query.exec(function (err, doc) {
        if (err) {
          return done(err);
        }
        if (doc) {
          expect(query.isFromCache).to.be(false);
          expect(doc.peer).to.be.ok();
          expect(doc.peer).to.be.a('object');
          expect(doc.peer.toObject()).to.eql(peer.toObject());
          done();
        }
      });
    });
  });
  
  it('should cache findOne query if the `cache` method is called', function (done) {
    var self = this;
    var query = People.findOne({});
    query.cache(true, 2).exec(function (err, docs) {
      expect(query.isFromCache).to.be(false);
      var time = Date.now();
      if (err) {
        return done(err);
      }
      People.findOne({}).exec(function (err, docs) {
        if (err) {
          return done(err);
        }
        People.findOne({}).exec(function (err, docs) {
          if (err) {
            return done(err);
          }
          People.findOne({}).exec(function (err, docs) {
          if (err) {
              return done(err);
            }
            People.findOne({}).exec(function (err, docs) {
              if (err) {
                return done(err);
              }
              query = People.findOne({}).cache().exec(function (err, docs) {
                if (err) {
                  return done(err);
                }
                if (docs) {
                  time = Date.now() - time;
                  expect(docs).to.be.ok();
                  expect(query.isFromCache).to.be(true);
                  done();
                }
              });
            });
          });
        });
      });
    });
  });
  
  it('should not cache a stream query if the `cache` method is not called', function (done) {
    function createStreamQuery (cb) {
        var query = People.find({}),
            stream = query.stream(),
            arr = [];
        
        stream
          .on('error', function (err) { done(err); })
          .on('data', function (data) { 
            arr.push(data.toObject());
            expect(data).to.be.ok();        
          })
          .on('close', function () { cb(arr); });
        
        expect(stream.pipe).to.be.a('function');
        return query;
    }
    
    var query0, query1;
    query0 = createStreamQuery(function (arr0) {
      expect(query0.isFromCache).to.be(false);
      query1 = createStreamQuery(function (arr1) {
        expect(query1.isFromCache).to.be(false);
        expect(arr0).to.eql(arr1);
        done();
      });
    })
  });
  
  it('should cache a stream query if the `cache` method is called', function (done) {
    function createStreamQuery (cb) {
        var query = People.find({}),
            stream = query.cache(true, 2).stream(),
            arr = [];
        
        stream
          .on('error', function (err) { done(err); })
          .on('data', function (data) { 
            arr.push(data.toObject());
            expect(data).to.be.ok();        
          })
          .on('close', function () { cb(arr); });
        
        expect(stream.pipe).to.be.a('function');
        return query;
    }
    
    var query0, query1;
    query0 = createStreamQuery(function (arr0) {
      expect(query0.isFromCache).to.be(false);
      query1 = createStreamQuery(function (arr1) {
        expect(query1.isFromCache).to.be(true);
        expect(arr0).to.eql(arr1);
        done();
      });
    })
  });
    
  it('should work with lean enabled', function (done) {
    var query = People.find({});
    query.lean().cache().exec(function (err, docs) {
      if (err) {
        return done(err);
      }
      generate(5, function(e) {
        if(e) {
          return done(err);
        }
        query = People.find({}).lean().cache().exec(function (err, docs) {
          if (err) {
            return done(err);
          }
          if (docs) {
            expect(query.isFromCache).to.be(true);
            // length should be 10 instead of 15 because these are cached docs
            expect(docs).to.have.length(10);
            expect(docs[0].save).to.be(undefined);
            done();
          }
        });
      });
    });
  });

  it('should cache query with specific ttl is passed to `ttl` method', function (done) {
    var query = People.find({});
    query.cache(true, 50).exec(function (err, docs) {
      if (err) {
        return done(err);
      }
      expect(query._ttl).to.be(50);
      // first time query, should not be from cache
      expect(query.isFromCache).to.be(false);
      query = People.find({}).cache(true, 40).exec(function (err, docs) {
        if (err) {
          return done(err);
        }
        if (docs) {
          expect(query._ttl).to.be(40);
          expect(query.isFromCache).to.be(true);
          done();
        }
      });
    });
  });

  it('should stop caching', function (done) {
    var query = People.find({});
    query.cache().exec(function (err, docs) {
      if (err) {
        return done(err);
      }
      generate(5, function(e) {
        if(e) {
          return done(e);
        }
        query = People.find({});
        query.cache(false).exec(function (err, docs) {
          if (err) {
            return done(err);
          }
          expect(query.isFromCache).to.be(false);
          expect(docs).to.have.length(15);
          done();
        });
      });
    });
  });
});
