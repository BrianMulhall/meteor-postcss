// Makes sure we can load peer dependencies from app's directory.
// See: https://github.com/juliancwirko/meteor-postcss/issues/15
//      https://github.com/meteor/meteor/issues/9865
Npm.require('app-module-path/cwd');

import { checkNpmVersions } from 'meteor/tmeasday:check-npm-versions';
import Future from 'fibers/future';

var sourcemap = Npm.require('source-map');

checkNpmVersions({
    'postcss': '^7.0.0',
}, 'juliancwirko:postcss');

var postCSS = require('postcss');
var postcssrc = require('postcss-load-config');


Plugin.registerMinifier({
    extensions: ['css']
},
    () => new CssToolsMinifier()
);

var loaded = false;
var postcssConfigPlugins = [];
var postcssConfigParser = null;
var postcssConfigExcludedPackages = [];

var loadPostcssConfig = function () {
    if (!loaded) {
        loaded = true;

        var config;
        try {
            config = Promise.await(postcssrc({ meteor: true }));

            postcssConfigPlugins = config.plugins || [];
            postcssConfigParser = config.options.parser || null;
            postcssConfigExcludedPackages = config.options.excludedPackages || [];
            // There is also "config.file" which is a path to the file we use to force
            // Meteor reload on any change, but it seems this is not (yet) possible.
        }
        catch (error) {
            // Do not emit an error if the error is that no config can be found.
            if (error.message.indexOf('No PostCSS Config found') < 0) {
                throw error;
            }
        }
    }
};

var isNotInExcludedPackages = function (excludedPackages, pathInBundle) {
    let processedPackageName;
    let exclArr = [];
    if (excludedPackages && excludedPackages instanceof Array) {
        exclArr = excludedPackages.map(packageName => {
            processedPackageName = packageName && packageName.replace(':', '_');
            return pathInBundle && pathInBundle.indexOf('packages/' + processedPackageName) > -1;
        });
    }
    return exclArr.indexOf(true) === -1;
};

var isNotImport = function (inputFileUrl) {
    return !(/\.import\.css$/.test(inputFileUrl) || /(?:^|\/)imports\//.test(inputFileUrl));
};

class CssToolsMinifier {

    constructor() { }

    processFilesForBundle(files, options) {
        console.log(files);
        console.log(options);

        loadPostcssConfig();

        var mode = options.minifyMode;

        if (!files.length) {
            return;
        }

        var filesToMerge = [];

        files.forEach(function (file) {
            if (isNotImport(file._source.url)) {
                filesToMerge.push(file);
            }
        });

        var merged = mergeCss(filesToMerge);

        if (mode === 'development') {
            files[0].addStylesheet({
                data: merged.code,
                sourceMap: merged.sourceMap,
                path: 'merged-stylesheets.css'
            });
            return;
        }

        // this is where the minification is 
        // perfromed when in production
        // mode
        var minifiedFiles = CssTools.minifyCss(merged.code);

        if (files.length) {
            minifiedFiles.forEach(function (minified) {
                files[0].addStylesheet({
                    data: minified
                });
            });
        }
    }
}

// Lints CSS files and merges them into one file, fixing up source maps and
// pulling any @import directives up to the top since the CSS spec does not
// allow them to appear in the middle of a file.
var mergeCss = function (css) {
    // Filenames passed to AST manipulator mapped to their original files
    var originals = {};

    // css is an array of files
    var cssAsts = css.map(function (file) {
        var filePath = file.getPathInBundle();
        originals[filePath] = file;

        var future = new Future();

        // check if the file is in a package that was excluded from being processed
        const isFileForPostCSS = isNotInExcludedPackages(postcssConfigExcludedPackages, filePath);

        // when a file is not meant to have postcss used on it we pass in no plugins
        // which takes the form of an empty array
        const postCssPlugins = isFileForPostCSS ? postcssConfigPlugins : [];

        // create a postcss processor using the configured plugins
        const processor = postCSS(postCssPlugins);

        processor.process(file.getContentsAsString(), {
            from: process.cwd() + file._source.url,
            parser: postcssConfigParser
        })
            .then(function (result) {
                result.warnings().forEach(function (warn) {
                    process.stderr.write(warn.toString());
                });
                future.return(result);
            })
            .catch(function (error) {
                var errMsg = error.message;
                if (error.name === 'CssSyntaxError') {
                    errMsg = error.message + '\n\n' + 'Css Syntax Error.' + '\n\n' + error.message + error.showSourceCode();
                }
                error.message = errMsg;
                future.return(error);
            });

        try {

            var parseOptions = {
                from: filePath,
                position: true
            };


            var postCssResult = future.wait();

            if (postCssResult.name === 'CssSyntaxError') {
                throw postCssResult;
            }

            // now call the meteor built in minifier  (which is actually postcss as well)
            var ast = CssTools.parseCss(postCssResult.css, parseOptions);
        } catch (err) {

            if (err.name === 'CssSyntaxError') {
                file.error({
                    message: err.message,
                    line: err.line,
                    column: err.column
                });
            } else if (err.reason) {
                file.error({
                    message: err.reason,
                    line: err.line,
                    column: err.column
                });
            } else {
                // Just in case it's not the normal error the library makes.
                file.error({
                    message: err.message
                });
            }

            return {
                type: "stylesheet",
                stylesheet: {
                    rules: []
                },
                filename: filePath
            };
        }

        return ast;
    });

    var warnCb = function (filename, msg) {
        // XXX make this a buildmessage.warning call rather than a random log.
        //     this API would be like buildmessage.error, but wouldn't cause
        //     the build to fail.
        console.log(filename + ': warn: ' + msg);
    };

    var mergedCssAst = CssTools.mergeCssAsts(cssAsts, warnCb);

    // Overwrite the CSS files list with the new concatenated file
    var stringifiedCss = CssTools.stringifyCss(mergedCssAst, {
        sourcemap: true,
        // don't try to read the referenced sourcemaps from the input
        inputSourcemaps: false
    });

    if (!stringifiedCss.code) {
        return {
            code: ''
        };
    }

    // Add the contents of the input files to the source map of the new file
    stringifiedCss.map.sourcesContent =
        stringifiedCss.map.sources.map(function (filename) {
            return originals[filename].getContentsAsString();
        });

    // If any input files had source maps, apply them.
    // Ex.: less -> css source map should be composed with css -> css source map
    var newMap = sourcemap.SourceMapGenerator.fromSourceMap(
        new sourcemap.SourceMapConsumer(stringifiedCss.map));

    Object.keys(originals).forEach(function (name) {
        var file = originals[name];
        if (!file.getSourceMap())
            return;
        try {
            newMap.applySourceMap(
                new sourcemap.SourceMapConsumer(file.getSourceMap()), name);
        } catch (err) {
            // If we can't apply the source map, silently drop it.
            //
            // XXX This is here because there are some less files that
            // produce source maps that throw when consumed. We should
            // figure out exactly why and fix it, but this will do for now.
        }
    });

    return {
        code: stringifiedCss.code,
        sourceMap: newMap.toString()
    };
};
