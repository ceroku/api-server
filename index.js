'use strict';

/**
 * Ensure that all environment variables are configured.
 */

var dotenv = require('dotenv');
dotenv.config();

[
  'DOMAIN',
  'MAIN_PATH',
  'PORT',
  'TOKEN',
].forEach(varName => {
  if (!process.env.hasOwnProperty(varName)) {
    throw new Error('Missing environment variable: ' + varName);
  }
});

/**
 * Module dependencies.
 */

var spawn = require('child_process').spawn;
var fs = require('fs');
var http = require('http');
var path = require('path');

var bodyParser = require('body-parser');
var Docker = require('dockerode');
var express = require('express');
var helmet = require('helmet');
var touch = require("touch");
var uuidv4 = require('uuid/v4');

/**
 * Verify that Docker is running.
 */

var socket = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
var stats  = fs.statSync(socket);

if (!stats.isSocket()) {
  throw new Error('Are you sure docker is running?');
}

/**
 * Initialize express server.
 */

var app = express();
var docker = new Docker({ socketPath: socket });
app.use(helmet());
app.use(bodyParser.json());

// [private] Create a new build based on req.body.revision
app.post('/apps/:app_name/builds', function(req, res, next) {
  // Checks if token is present
  if (! req.query.token || req.query.token !== process.env.TOKEN) {
    var err = new Error();
    err.status = 404;
    return next(err);
  }

  // Verifies if app_name is valid
  var app_path = path.join(process.env.MAIN_PATH, req.params.app_name);
  if (! fs.existsSync(app_path)) {
    return res.status(500).json({ 'error': 'App not found' });
  }

  // Checks if revision field is supplied
  var revision = req.body.revision;
  if (! req.body || ! revision) {
    return res.status(500).json({ 'error': 'Invalid revision' });
  }

  // Verifies if file is there
  console.log(req.body);
  var source_file = path.join(app_path, 'sources', `${revision}.tgz`);
  if (! fs.existsSync(source_file)) {
    return res.status(500).json({ 'error': 'Invalid revision' });
  }

  console.log(`Build started for ${req.params.app_name}:`);
  console.log(`\tRevision: ${revision}`);

  // Generate build id and create directory for build
  var build_id;
  var build_dir;
  do {
    build_id = uuidv4();
    build_dir = path.join(app_path, 'builds', build_id);
  } while (fs.existsSync(build_dir));
  fs.mkdirSync(build_dir);

  // Create logs directory
  var logs_dir = path.join(build_dir, 'logs');
  fs.mkdirSync(logs_dir);

  // Touch slug.tgz so that we can mount it to container
  touch.sync(path.join(build_dir, 'slug.tgz'));

  // Write stream for build and error logs
  var log_stream = fs.createWriteStream(path.join(logs_dir, 'build.log'));
  var err_stream = fs.createWriteStream(path.join(logs_dir, 'error.log'));

  // Return response to user first
  res.json({
    output_stream_url: `${process.env.DOMAIN}/apps/${req.params.app_name}/builds/${build_id}/logs`
  });

  // Background work
  var statusCode;
  console.log('\tCreating container...');
  docker.run(
    'imjching/slugc',
    ['/bin/bash', '-c', 'tar -xzf /tmp/sources/source.tgz && /build'],
    [log_stream, err_stream], // closes the stream as well
    {
      HostConfig: {
        Binds: [
          `${process.env.MAIN_PATH}/${req.params.app_name}/sources/${revision}.tgz:/tmp/sources/source.tgz`,
          `${process.env.MAIN_PATH}/${req.params.app_name}/builds/${build_id}/slug.tgz:/tmp/slugs/slug.tgz`,
          `${process.env.MAIN_PATH}/${req.params.app_name}/cache:/tmp/cache`,
        ],
        AutoRemove: true
      },
      Tty: false
    }
  ).then(function({ output }) {
    console.log('\tContainer created...');
    statusCode = output.StatusCode;

    // Create log stream again since it was closed earlier
    log_stream = fs.createWriteStream(path.join(logs_dir, 'build.log'), {'flags': 'a'});
    log_stream.write('-----> Launching...\n');
    // Do not do docker.run here, since docker.run calls container.wait();
    return docker.createContainer({
      Image: 'imjching/slugr',
      Labels: {
        'traefik.backend': req.params.app_name,
        'traefik.docker.network': 'web',
        'traefik.frontend.rule': `Host:${req.params.app_name}.ceroku.com`,
        'traefik.enable': 'true'
      },
      Env: [
        'PORT=5000',
      ],
      ExposedPorts: {
        '5000/tcp': { }
      },
      HostConfig: {
        Binds: [
          `${process.env.MAIN_PATH}/${req.params.app_name}/builds/${build_id}/slug.tgz:/tmp/slugs/slug.tgz`
        ],
        AutoRemove: true,
        // PublishAllPorts: true,
        // RestartPolicy: {
        //   Name: 'always'
        // },
        NetworkMode: 'web'
      },
      Cmd: ['/bin/bash', '-c', 'tar -xzf /tmp/slugs/slug.tgz && /start web']
    });
  }).then(function(container) {
    console.log('\tStarting container...');
    return container.start();
  }).then(function(container) {
    return container.inspect();
  }).then(function(container) {
    var Ports = container.NetworkSettings.Ports;
    if (!('5000/tcp' in Ports)) {
      console.log('\tERROR');
      return;
    }
    // Here, we should get router to route url to this new port,
    // then filter based on app name and release id,
    // and finally remove old containers
    // insert new version into database
    log_stream.write('       Released v6\n');
    log_stream.write(`       http://${req.params.app_name}.ceroku.com/ deployed to Ceroku\n`);
    log_stream.end();
    err_stream.end();

    console.log('\tDONE');
    // console.log('\t' + JSON.stringify(Ports, null, 2));
    return docker.listContainers({
      filters: JSON.stringify({
        label: [`traefik.backend=${req.params.app_name}`],
        before: [container.Id]
      })
    });
  }).then(function(containers) {
    var tmp_stream = fs.createWriteStream(path.join(logs_dir, 'build.tmp'));
    tmp_stream.write(statusCode + '\n');
    tmp_stream.end();

    containers.forEach(function (containerInfo) {
      docker.getContainer(containerInfo.Id).stop(function(err, result) {
        // ignore
      });
    });
  }).catch(function(err) {
    console.log(err);
  });
});

// [public] path to stream build logs
app.get('/apps/:app_name/builds/:build_id/logs', function(req, res, next) {
  // Set Content-Type to text/plain
  res.type('.txt');

  // Verifies if app_name is valid
  var app_path = path.join(process.env.MAIN_PATH, req.params.app_name);
  if (! fs.existsSync(app_path)) {
    return res.status(404).send('404 Not Found');
  }

  // Verifies if build_id is valid
  var V4_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[4][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i;
  if (! V4_UUID.test(req.params.build_id)) {
    return res.status(404).send('404 Not Found');
  }

  var logs_dir = path.join(app_path, 'builds', req.params.build_id, 'logs');
  var log = path.join(logs_dir, 'build.log');
  var tmp = path.join(logs_dir, 'build.tmp');

  // Check if log exists
  if (! fs.existsSync(log)) {
    return res.status(404).send('404 Not Found');
  }

  // If build is done, send everything
  if (fs.existsSync(tmp)) {
    return res.sendFile(log);
  }

  var ps = spawn('tail', ['-f', '-n', '+1', log]);
  var lastReceiveTime = new Date().getTime();

  ps.stdout.on('data', function(data) {
    lastReceiveTime = new Date().getTime();
    res.write(data);
  });

  var timerId = setInterval(function() {
    if (lastReceiveTime + 10000 < new Date() || fs.existsSync(tmp)) {
      // Check if ${req.params.build_id}.tmp exists
      // TODO: remove .tmp at end of build once database implementation is ready
      clearInterval(timerId);
      ps.kill();
      return res.end(); // Stop the streaming
    }
  }, 1000);

  req.on('close', function() {
    clearInterval(timerId);
    ps.kill();
  });
});

/**
 * 404 handler.
 */

app.use(function(req, res, next) {
  // console.log(req.url);
  // console.log(req.headers);
  var err = new Error();
  err.status = 404;
  next(err);
});

/**
 * Error handler.
 */

app.use(function(err, req, res, next) {
  err.status = err.status || 500;
  console.log(err);
  res.status(err.status).send(err.status + ' ' + http.STATUS_CODES[err.status]);
});

/**
 * Listen on provided port, on all network interfaces.
 */

var PORT = process.env.PORT || 9002;
app.listen(PORT, function(error) {
  error
  ? console.error(error)
  : console.log(`-----> Build Server listening on port ${PORT}`);
});
