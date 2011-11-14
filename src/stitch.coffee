_     = require 'underscore'
async = require 'async'
fs    = require 'fs'

{extname, join, normalize} = require 'path'

exports.compilers = compilers =
  js: (module, filename) ->
    content = fs.readFileSync filename, 'utf8'
    module._compile content, filename

try
  CoffeeScript = require 'coffee-script'
  compilers.coffee = (module, filename) ->
    content = CoffeeScript.compile fs.readFileSync filename, 'utf8'
    module._compile content, filename
catch err

try
  eco = require 'eco'
  if eco.precompile
    compilers.eco = (module, filename) ->
      content = eco.precompile fs.readFileSync filename, 'utf8'
      module._compile "module.exports = #{content}", filename
  else
    compilers.eco = (module, filename) ->
      content = eco.compile fs.readFileSync filename, 'utf8'
      module._compile content, filename
catch err

commonPrefix = (paths) ->
  return '' if not paths

  s1 = paths[0]
  s2 = paths[paths.length - 1]
  for c, i in s1
    if c != s2[i]
      return s1[...i]
  s1

exports.Package = class Package
  constructor: (config) ->
    @identifier   = config.identifier ? 'require'
    @paths        = config.paths ? ['lib']
    @dependencies = config.dependencies ? []
    @compilers    = _.extend {}, compilers, config.compilers

    @cache        = config.cache ? true
    @debug        = config.debug ? false
    @mtimeCache   = {}
    @compileCache = {}
    if @debug
      @files = {}

  compile: (callback) ->
    async.parallel [
      @compileDependencies
      @compileSources
    ], (err, parts) ->
      if err then callback err
      else callback null, parts.join("\n")

  compileDependencies: (callback) =>
    async.map @dependencies, fs.readFile, (err, dependencySources) =>
      if err then callback err
      else callback null, dependencySources.join("\n")

  compileSources: (callback) =>
    async.reduce @paths, {}, _.bind(@gatherSourcesFromPath, @), (err, sources) =>
      return callback err if err
          
      result = "({"    
      index = 0
      for name, {filename, source} of sources
        result += if index++ is 0 then "" else ", "
        result += JSON.stringify name
        result += ": function(exports, require, module) {#{source}}"

      result += """
        });\n
      """

      callback err, @getClientJavascript(result)
  
  compileDebug: (callback) ->
    async.reduce @paths, {}, _.bind(@gatherSourcesFromPath, @), (err, sources) =>
      return callback err if err

      result = [";"]
      files = @dependencies[0...@dependencies.length]
      for name, {base, filename} of sources
        files.push "#{base}#{filename}"
      @commonBase = commonPrefix(files)
      for file in files
        filename = file.replace @commonBase, ''
        result.push "require.load('#{filename}');"
      
      callback err, @getClientJavascript(result.join("\n"))

  createServer: ->
    (req, res, next) =>
      if @debug
        @baseURL = require('url').format
          protocol: 'http'
          host: req.header('host')

      @[if @debug then 'compileDebug' else 'compile'] (err, source) ->
        if err then @showError err, res
        else
          res.writeHead 200, 'Content-Type': 'text/javascript'
          res.end source

  serveModule: ->
    (req, res, next) =>
      path = join @commonBase, req.params[0]
      if @compilers[extname(path).slice(1)] and path not in @dependencies
      
        @getRelativePath path, (err, relativePath) =>
          return @showError err, res if err
        
          @compileFile path, (err, source) =>
            if err then @showError err, res
            else
              extension = extname relativePath
              key = JSON.stringify relativePath.slice(0, -extension.length)
              res.writeHead 200, 'Content-Type': 'text/javascript'
              res.end "require.define({#{key}: function(exports, require, module) {#{source}}});"
      else
        next()
  
  showError: (err, res) ->
    console.error "#{err.stack}"
    message = "" + err.stack
    res.writeHead 500, 'Content-Type': 'text/javascript'
    res.end "throw #{JSON.stringify(message)}"

  gatherSourcesFromPath: (sources, sourcePath, callback) ->
    fs.stat sourcePath, (err, stat) =>
      return callback err if err

      if stat.isDirectory()
        @getFilesInTree sourcePath, (err, paths) =>
          return callback err if err
          async.reduce paths, sources, _.bind(@gatherCompilableSource, @), callback
      else
        @gatherCompilableSource sources, sourcePath, callback

  gatherCompilableSource: (sources, path, callback) ->
    if @compilers[extname(path).slice(1)]
      @getRelativePath path, (err, relativePath) =>
        return callback err if err

        @compileFile path, (err, source) ->
          if err then callback err
          else
            extension = extname relativePath
            key       = relativePath.slice(0, -extension.length)
            sources[key] =
              base: path.replace relativePath, ''
              filename: relativePath
              source:   source
            callback err, sources
    else
      callback null, sources

  getRelativePath: (path, callback) ->
    fs.realpath path, (err, sourcePath) =>
      return callback err if err

      async.map @paths, fs.realpath, (err, expandedPaths) ->
        return callback err if err

        for expandedPath in expandedPaths
          base = expandedPath + "/"
          if sourcePath.indexOf(base) is 0
            return callback null, sourcePath.slice base.length
        callback new Error "#{path} isn't in the require path"

  compileFile: (path, callback) ->
    extension = extname(path).slice(1)

    if @cache and @compileCache[path] and @mtimeCache[path] is @compileCache[path].mtime
      callback null, @compileCache[path].source
    else if compile = @compilers[extension]
      source = null
      mod =
        _compile: (content, filename) ->
          source = content

      try
        compile mod, path

        if @cache and mtime = @mtimeCache[path]
          @compileCache[path] = {mtime, source}

        callback null, source
      catch err
        if err instanceof Error
          err.message = "can't compile #{path}\n#{err.message}"
        else
          err = new Error "can't compile #{path}\n#{err}"
        callback err
    else
      callback new Error "no compiler for '.#{extension}' files"

  walkTree: (directory, callback) ->
    fs.readdir directory, (err, files) =>
      return callback err if err

      async.forEach files, (file, next) =>
        return next() if file.match /^\./
        filename = join directory, file

        fs.stat filename, (err, stats) =>
          @mtimeCache[filename] = stats?.mtime?.toString()

          if !err and stats.isDirectory()
            @walkTree filename, (err, filename) ->
              if filename
                callback err, filename
              else
                next()
          else
            callback err, filename
            next()
      , callback

  getFilesInTree: (directory, callback) ->
    files = []
    @walkTree directory, (err, filename) ->
      if err
        callback err
      else if filename
        files.push filename
      else
        callback err, files.sort()

  getClientJavascript: (code) ->
    return """
      (function(/*! Stitch !*/) {
        if (!this.#{@identifier}) {
          var head, modules = {}, cache = {}, require = function(name, root) {
            var path = expand(root, name), module = cache[path] || cache[path + '/index'], fn;
            if (module) {
              return module;
            } else if (fn = modules[path] || modules[path = expand(path, './index')]) {
              module = {id: name, exports: {}};
              try {
                cache[path] = module.exports;
                fn(module.exports, function(name) {
                  return require(name, dirname(path));
                }, module);
                return cache[path] = module.exports;
              } catch (err) {
                delete cache[path];
                throw err;
              }
            } else {
              throw 'module \\'' + name + '\\' not found';
            }
          }, expand = function(root, name) {
            var results = [], parts, part;
            if (/^\\.\\.?(\\/|$)/.test(name)) {
              parts = [root, name].join('/').split('/');
            } else {
              parts = name.split('/');
            }
            for (var i = 0, length = parts.length; i < length; i++) {
              part = parts[i];
              if (part == '..') {
                results.pop();
              } else if (part != '.' && part != '') {
                results.push(part);
              }
            }
            return results.join('/');
          }, dirname = function(path) {
            return path.split('/').slice(0, -1).join('/');
          };
          this.#{@identifier} = function(name) {
            return require(name, '');
          }
          this.#{@identifier}.define = function(bundle) {
            for (var key in bundle)
              modules[key] = bundle[key];
          };
          this.#{@identifier}.load = function(path) {
            if (!head) head = document.getElementsByTagName('head')[0];
            var el = document.createElement('script');
            el.src = "#{@baseURL}/" + path;
            el.async = false;
            head.insertBefore(el, head.firstChild);
          };
        }
        return this.#{@identifier}.define;
      }).call(this)#{code}"""


exports.createPackage = (config) ->
  new Package config
