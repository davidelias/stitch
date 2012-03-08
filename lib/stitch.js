(function() {
  var CoffeeScript, Package, async, commonPrefix, compilers, eco, extname, fs, join, normalize, _, _ref;
  var __bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; }, __hasProp = Object.prototype.hasOwnProperty, __indexOf = Array.prototype.indexOf || function(item) { for (var i = 0, l = this.length; i < l; i++) { if (__hasProp.call(this, i) && this[i] === item) return i; } return -1; };

  _ = require('underscore');

  async = require('async');

  fs = require('fs');

  _ref = require('path'), extname = _ref.extname, join = _ref.join, normalize = _ref.normalize;

  exports.compilers = compilers = {
    js: function(module, filename) {
      var content;
      content = fs.readFileSync(filename, 'utf8');
      return module._compile(content, filename);
    }
  };

  try {
    CoffeeScript = require('coffee-script');
    compilers.coffee = function(module, filename) {
      var content;
      content = CoffeeScript.compile(fs.readFileSync(filename, 'utf8'));
      return module._compile(content, filename);
    };
  } catch (err) {

  }

  try {
    eco = require('eco');
    if (eco.precompile) {
      compilers.eco = function(module, filename) {
        var content;
        content = eco.precompile(fs.readFileSync(filename, 'utf8'));
        return module._compile("module.exports = " + content, filename);
      };
    } else {
      compilers.eco = function(module, filename) {
        var content;
        content = eco.compile(fs.readFileSync(filename, 'utf8'));
        return module._compile(content, filename);
      };
    }
  } catch (err) {

  }

  commonPrefix = function(paths) {
    var c, i, s1, s2, _len;
    if (!paths) return '';
    s1 = paths[0];
    s2 = paths[paths.length - 1];
    for (i = 0, _len = s1.length; i < _len; i++) {
      c = s1[i];
      if (c !== s2[i]) return s1.slice(0, i);
    }
    return s1;
  };

  exports.Package = Package = (function() {

    function Package(config) {
      this.compileSources = __bind(this.compileSources, this);
      this.compileDependencies = __bind(this.compileDependencies, this);
      var _ref2, _ref3, _ref4, _ref5, _ref6;
      this.identifier = (_ref2 = config.identifier) != null ? _ref2 : 'require';
      this.paths = (_ref3 = config.paths) != null ? _ref3 : ['lib'];
      this.dependencies = (_ref4 = config.dependencies) != null ? _ref4 : [];
      this.compilers = _.extend({}, compilers, config.compilers);
      this.cache = (_ref5 = config.cache) != null ? _ref5 : true;
      this.debug = (_ref6 = config.debug) != null ? _ref6 : false;
      this.mtimeCache = {};
      this.compileCache = {};
      if (this.debug) this.files = {};
    }

    Package.prototype.compile = function(callback) {
      return async.parallel([this.compileDependencies, this.compileSources], function(err, parts) {
        if (err) {
          return callback(err);
        } else {
          return callback(null, parts.join("\n"));
        }
      });
    };

    Package.prototype.compileDependencies = function(callback) {
      var _this = this;
      return async.map(this.dependencies, fs.readFile, function(err, dependencySources) {
        if (err) {
          return callback(err);
        } else {
          return callback(null, dependencySources.join("\n"));
        }
      });
    };

    Package.prototype.compileSources = function(callback) {
      var _this = this;
      return async.reduce(this.paths, {}, _.bind(this.gatherSourcesFromPath, this), function(err, sources) {
        var filename, index, name, result, source, _ref2;
        if (err) return callback(err);
        result = "({";
        index = 0;
        for (name in sources) {
          _ref2 = sources[name], filename = _ref2.filename, source = _ref2.source;
          result += index++ === 0 ? "" : ", ";
          result += JSON.stringify(name);
          result += ": function(exports, require, module) {" + source + "}";
        }
        result += "});\n";
        return callback(err, _this.getClientJavascript(result));
      });
    };

    Package.prototype.compileDebug = function(callback) {
      var _this = this;
      return async.reduce(this.paths, {}, _.bind(this.gatherSourcesFromPath, this), function(err, sources) {
        var base, delimiter, file, filename, files, i, name, result, scriptAsync, _len, _ref2;
        if (err) return callback(err);
        result = [";", "require.load(["];
        files = _this.dependencies.slice(0, _this.dependencies.length);
        for (name in sources) {
          _ref2 = sources[name], base = _ref2.base, filename = _ref2.filename;
          files.push("" + base + filename);
        }
        _this.commonBase = commonPrefix(files);
        for (i = 0, _len = files.length; i < _len; i++) {
          file = files[i];
          filename = file.replace(_this.commonBase, '');
          scriptAsync = __indexOf.call(_this.dependencies, file) >= 0 ? 'false' : 'true';
          delimiter = i === files.length - 1 ? '' : ',';
          result.push("  {path: '" + filename + "', async: " + scriptAsync + "}" + delimiter);
        }
        result.push("])");
        return callback(err, _this.getClientJavascript(result.join("\n")));
      });
    };

    Package.prototype.createServer = function(uglify) {
      var _this = this;
      return function(req, res, next) {
        if (_this.debug) {
          _this.baseURL = require('url').format({
            protocol: 'http',
            host: req.header('host')
          });
        }
        return _this[_this.debug ? 'compileDebug' : 'compile'](function(err, source) {
          if (err) {
            return _this.showError(err, res);
          } else {
            res.writeHead(200, {
              'Content-Type': 'text/javascript'
            });
            return res.end(uglify ? uglify(source) : source);
          }
        });
      };
    };

    Package.prototype.createModuleServer = function() {
      var _this = this;
      return function(req, res, next) {
        var path;
        path = join(_this.commonBase, req.params[0]);
        if (__indexOf.call(_this.dependencies, path) >= 0) {
          return fs.readFile(path, function(err, source) {
            if (err) {
              return _this.showError(err, res);
            } else {
              res.writeHead(200, {
                'Content-Type': 'text/javascript'
              });
              return res.end(source);
            }
          });
        } else if (_this.compilers[extname(path).slice(1)]) {
          return _this.getRelativePath(path, function(err, relativePath) {
            if (err) {
              return _this.showError(err, res);
            } else {
              return _this.compileFile(path, function(err, source) {
                var extension, key;
                if (err) {
                  return _this.showError(err, res);
                } else {
                  extension = extname(relativePath);
                  key = JSON.stringify(relativePath.slice(0, -extension.length));
                  res.writeHead(200, {
                    'Content-Type': 'text/javascript'
                  });
                  return res.end("require.define({" + key + ": function(exports, require, module) {" + source + "}});");
                }
              });
            }
          });
        } else {
          return next();
        }
      };
    };

    Package.prototype.showError = function(err, res) {
      var message;
      console.error("" + err.stack);
      message = "" + err.stack;
      res.writeHead(500, {
        'Content-Type': 'text/javascript'
      });
      return res.end("throw " + (JSON.stringify(message)));
    };

    Package.prototype.gatherSourcesFromPath = function(sources, sourcePath, callback) {
      var _this = this;
      return fs.stat(sourcePath, function(err, stat) {
        if (err) return callback(err);
        if (stat.isDirectory()) {
          return _this.getFilesInTree(sourcePath, function(err, paths) {
            if (err) return callback(err);
            return async.reduce(paths, sources, _.bind(_this.gatherCompilableSource, _this), callback);
          });
        } else {
          return _this.gatherCompilableSource(sources, sourcePath, callback);
        }
      });
    };

    Package.prototype.gatherCompilableSource = function(sources, path, callback) {
      var _this = this;
      if (this.compilers[extname(path).slice(1)]) {
        return this.getRelativePath(path, function(err, relativePath) {
          if (err) return callback(err);
          return _this.compileFile(path, function(err, source) {
            var extension, key;
            if (err) {
              return callback(err);
            } else {
              extension = extname(relativePath);
              key = relativePath.slice(0, -extension.length);
              sources[key] = {
                base: path.replace(relativePath, ''),
                filename: relativePath,
                source: source
              };
              return callback(err, sources);
            }
          });
        });
      } else {
        return callback(null, sources);
      }
    };

    Package.prototype.getRelativePath = function(path, callback) {
      var _this = this;
      return fs.realpath(path, function(err, sourcePath) {
        if (err) return callback(err);
        return async.map(_this.paths, fs.realpath, function(err, expandedPaths) {
          var base, expandedPath, _i, _len;
          if (err) return callback(err);
          for (_i = 0, _len = expandedPaths.length; _i < _len; _i++) {
            expandedPath = expandedPaths[_i];
            base = expandedPath + "/";
            if (sourcePath.indexOf(base) === 0) {
              return callback(null, sourcePath.slice(base.length));
            }
          }
          return callback(new Error("" + path + " isn't in the require path"));
        });
      });
    };

    Package.prototype.compileFile = function(path, callback) {
      var compile, extension, mod, mtime, source;
      extension = extname(path).slice(1);
      if (this.cache && this.compileCache[path] && this.mtimeCache[path] === this.compileCache[path].mtime) {
        return callback(null, this.compileCache[path].source);
      } else if (compile = this.compilers[extension]) {
        source = null;
        mod = {
          _compile: function(content, filename) {
            return source = content;
          }
        };
        try {
          compile(mod, path);
          if (this.cache && (mtime = this.mtimeCache[path])) {
            this.compileCache[path] = {
              mtime: mtime,
              source: source
            };
          }
          return callback(null, source);
        } catch (err) {
          if (err instanceof Error) {
            err.message = "can't compile " + path + "\n" + err.message;
          } else {
            err = new Error("can't compile " + path + "\n" + err);
          }
          return callback(err);
        }
      } else {
        return callback(new Error("no compiler for '." + extension + "' files"));
      }
    };

    Package.prototype.walkTree = function(directory, callback) {
      var _this = this;
      return fs.readdir(directory, function(err, files) {
        if (err) return callback(err);
        return async.forEach(files, function(file, next) {
          var filename;
          if (file.match(/^\./)) return next();
          filename = join(directory, file);
          return fs.stat(filename, function(err, stats) {
            var _ref2;
            _this.mtimeCache[filename] = stats != null ? (_ref2 = stats.mtime) != null ? _ref2.toString() : void 0 : void 0;
            if (!err && stats.isDirectory()) {
              return _this.walkTree(filename, function(err, filename) {
                if (filename) {
                  return callback(err, filename);
                } else {
                  return next();
                }
              });
            } else {
              callback(err, filename);
              return next();
            }
          });
        }, callback);
      });
    };

    Package.prototype.getFilesInTree = function(directory, callback) {
      var files;
      files = [];
      return this.walkTree(directory, function(err, filename) {
        if (err) {
          return callback(err);
        } else if (filename) {
          return files.push(filename);
        } else {
          return callback(err, files.sort());
        }
      });
    };

    Package.prototype.getClientJavascript = function(suffix) {
      var code;
      code = "(function(/*! Stitch !*/) {\n  if (!this." + this.identifier + ") {\n    var modules = {}, cache = {}, require = function(name, root) {\n      var path = expand(root, name), module = cache[path] || cache[path + '/index'], fn;\n      if (module) {\n        return module;\n      } else if (fn = modules[path] || modules[path = expand(path, './index')]) {\n        module = {id: name, exports: {}};\n        try {\n          cache[path] = module.exports;\n          fn(module.exports, function(name) {\n            return require(name, dirname(path));\n          }, module);\n          return cache[path] = module.exports;\n        } catch (err) {\n          delete cache[path];\n          console.log(err.stack);\n          throw err;\n        }\n      } else {\n        throw 'module \\'' + name + '\\' not found';\n      }\n    }, expand = function(root, name) {\n      var results = [], parts, part;\n      if (/^\\.\\.?(\\/|$)/.test(name)) {\n        parts = [root, name].join('/').split('/');\n      } else {\n        parts = name.split('/');\n      }\n      for (var i = 0, length = parts.length; i < length; i++) {\n        part = parts[i];\n        if (part == '..') {\n          results.pop();\n        } else if (part != '.' && part != '') {\n          results.push(part);\n        }\n      }\n      return results.join('/');\n    }, dirname = function(path) {\n      return path.split('/').slice(0, -1).join('/');\n    };\n    this." + this.identifier + " = function(name) {\n      return require(name, '');\n    };\n    this." + this.identifier + ".define = function(bundle) {\n      for (var key in bundle)\n        modules[key] = bundle[key];\n    };\n    this." + this.identifier + ".ready = function(name) {\n      if (/complete|loaded|interactive/.test(document.readyState)) callback();\n      document.addEventListener('DOMContentLoaded', require.bind(null, name, ''), false);\n    };\n";
      if (this.debug) {
        code += "var readyEvent = document.createEvent('Event');\nreadyEvent.initEvent('ready', true, true);\nthis." + this.identifier + ".ready = function(name) {\n  if (/complete|loaded|interactive/.test(document.readyState)) callback();\n  document.addEventListener('ready', require.bind(null, name, ''), false);\n};\n\nthis." + this.identifier + ".load = function(modules) {\n  var module;\n  (function load() {\n    if (module = modules.shift()){\n      var el = document.createElement('script');\n      el.src = \"" + this.baseURL + "/\" + module.path;\n      el.async = module.async;\n      el.onload = load;\n      document.head.appendChild(el);\n    }else{\n      document.dispatchEvent(readyEvent);\n    };\n  })();\n};\n";
      }
      code += "  }\n  return this." + this.identifier + ".define;\n}).call(this)" + suffix;
      return code;
    };

    return Package;

  })();

  exports.createPackage = function(config) {
    return new Package(config);
  };

}).call(this);
