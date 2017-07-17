var browserify = require('browserify')
var gulp = require('gulp')
var source = require('vinyl-source-stream')
var buffer = require('vinyl-buffer')
var globby = require('globby')
var through = require('through2')
var TestServer = require('karma').Server

gulp.task('test', ['javascript'], function (done) {
  new TestServer({
    configFile: __dirname + '/karma.conf.js',
    singleRun: !(process.argv.includes('watch'))
  }, done).start()
})

gulp.task('javascript', function () {
  var bundledStream = through()

  bundledStream
    .pipe(source('specs.js'))
    .pipe(buffer())
    .pipe(gulp.dest('./dist/js/'))

  globby(['./spec/indexeddb_spec.js']).then(function (entries) {
    browserify({entries: entries})
    .transform('babelify', {presets: ['es2015']})
    .bundle()
    .pipe(bundledStream)
  }).catch(function (err) {
    bundledStream.emit('error', err)
  })

  return bundledStream
})

gulp.task('watch', function () {
  gulp.watch('node_modules/nucleotides/src/**/*.js', ['javascript'])
  gulp.watch('spec/indexeddb_spec.js', ['javascript'])
  gulp.watch('index.js', ['javascript'])
})
