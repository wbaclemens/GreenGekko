var _ = require('lodash');
var util = require('../../core/util.js');
var config = util.getConfig();
var log = require(util.dirs().core + 'log');
var moment = require('moment');

var handle = require('./handle');
var postgresUtil = require('./util');
const pg = require('pg');

const { Query } = require('pg');

var Reader = function(mydb) {
  _.bindAll(this);

  if (mydb === undefined)
     this.db = handle;
  else
     this.db = new pg.Pool({ connectionString: config.postgresql.connectionString + '/' + mydb, });
}

// returns the furthest point (up to `from`) in time we have valid data from
Reader.prototype.mostRecentWindow = function(from, to, next) {
  to = to.unix();
  from = from.unix();
  var maxAmount = to - from + 1;
  
  this.db.connect((err, client, done) => {

    if(err) {
      log.error(err);
      return util.die(err.message);
    }

    var query = client.query(new Query(`
      SELECT start from ${postgresUtil.table('candles')}
      WHERE start <= ${to} AND start >= ${from}
      ORDER BY start DESC
    `), function (err, result) {
      if (err) {
        // bail out if the table does not exist
        if (err.message.indexOf(' does not exist') !== -1)
          return next(false);

        log.error(err);

        function sleep(ms) {
          return new Promise(resolve => setTimeout(resolve, ms));
        }

        const waitNdie = async function() {
          await sleep(1000);
          return util.die('DB error while reading mostRecentWindow');
        }
        waitNdie();
      }
    });

    var rows = [];
    query.on('row', function(row) {
      rows.push(row);
    });

    // After all data is returned, close connection and return results
    query.on('end', function() {
      done();
      // no candles are available
      if(rows.length === 0) {
        return next(false);
      }

      if(rows.length === maxAmount) {

        // full history is available!

        return next({
          from: from,
          to: to,
          consistency: 'Full db data without gaps!'
        });
      }

      // we have at least one gap, figure out where
      var mostRecent = _.first(rows).start;
      var leastRecent = _.last(rows).start;

      var gapIndex = _.findIndex(rows, function(r, i) {
        return r.start !== mostRecent - i * 60;
      });

      // if there was no gap in the records, but
      // there were not enough records.
      if(gapIndex === -1) {
        return next({
          from: leastRecent,
          to: mostRecent,
          consistency: 'No db data gap, but missing history (available from ' + moment.unix(leastRecent).utc().format() + ' to ' + moment.unix(mostRecent).utc().format() + ')'
        });
      }

      // else return mostRecent and the
      // the minute before the gap
      return next({
        from: leastRecent,
        to: rows[ gapIndex - 1 ].start,
        consistency: 'DB data has a gap at ' + moment.unix(rows[ gapIndex - 1 ].start).utc().format()
      });
    });
  });  
}

Reader.prototype.tableExists = function (name, next) {
  this.db.connect((err,client,done) => {
    client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema='${postgresUtil.schema()}'
        AND table_name='${postgresUtil.table(name)}';
    `, function(err, result) {
      done();
      if (err) {
        return util.die('DB error at `tableExists`');
      }

      next(null, result.rows.length === 1);
    });
  });  
}

Reader.prototype.get = function(from, to, what, next, mytable) {
  if(what === 'full'){
    what = '*';
  }

  var querytable = postgresUtil.table('candles');
  if (mytable !== undefined) {
    querytable = mytable;
  }
  
  this.db.connect((err,client,done) => {
    var query = client.query(new Query(`
    SELECT ${what} from ${querytable}
    WHERE start <= ${to} AND start >= ${from}
    ORDER BY start ASC
    `));

    var rows = [];
    query.on('row', function(row) {
      rows.push(row);
    });

    query.on('end',function(){
      done();
      next(null, rows);
    });
  });  
}

Reader.prototype.count = function(from, to, next) {
  this.db.connect((err,client,done) => {
    if(err) {
      log.error(err);
      return util.die(err.message);
    }

    var query = client.query(new Query(`
      SELECT COUNT(*) as count from ${postgresUtil.table('candles')}
      WHERE start <= ${to} AND start >= ${from}
    `));
    var rows = [];
    query.on('row', function(row) {
      rows.push(row);
    });

    query.on('end',function(){
      done();
      next(null, _.first(rows).count);
    });
  });  
}

Reader.prototype.countTotal = function(next) {
  this.db.connect((err,client,done) => {
    var query = client.query(new Query(`
    SELECT COUNT(*) as count from ${postgresUtil.table('candles')}
    `));
    var rows = [];
    query.on('row', function(row) {
      rows.push(row);
    });

    query.on('end',function(){
      done();
      next(null, _.first(rows).count);
    });
  });  
}

Reader.prototype.getBoundry = function(next) {
  this.db.connect((err,client,done) => {
    var query = client.query(new Query(`
    SELECT (
      SELECT start
      FROM ${postgresUtil.table('candles')}
      ORDER BY start LIMIT 1
    ) as first,
    (
      SELECT start
      FROM ${postgresUtil.table('candles')}
      ORDER BY start DESC
      LIMIT 1
    ) as last
    `));
    var rows = [];
    query.on('row', function(row) {
      rows.push(row);
    });

    query.on('end',function(){
      done();
      next(null, _.first(rows));
    });
  });  
}

Reader.prototype.close = function() {
  //obsolete due to connection pooling
  //this.db.end();
}

module.exports = Reader;
