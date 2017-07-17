var browserify = require('browserify')
var gulp = require('gulp')
var source = require('vinyl-source-stream')
var buffer = require('vinyl-buffer')
var globby = require('globby')
var through = require('through2')
var jasmineBrowser = require('gulp-jasmine-browser')
var watch = require('gulp-watch')

gulp.task('jasmine', function () {
  var filesForTest = ['dist/js/*.js']
  return gulp.src(filesForTest)
    .pipe(watch(filesForTest))
    .pipe(jasmineBrowser.specRunner({console: true}))
    .pipe(jasmineBrowser.server({port: 8080}))
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
