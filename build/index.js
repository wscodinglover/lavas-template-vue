/**
 * @file index.js
 * @author lavas
 */
import RouteManager from './route-manager';
import Renderer from './renderer';
import WebpackConfig from './webpack';
import ConfigReader from './config-reader';

import privateFileFactory from './middlewares/privateFile';
import ssrFactory from './middlewares/ssr';
import koaErrorFactory from './middlewares/koaError';
import expressErrorFactory from './middlewares/expressError';

import ora from 'ora';
import chokidar from 'chokidar';

import composeMiddleware from 'compose-middleware';
import composeKoa from 'koa-compose';
import c2k from 'koa-connect';
import serve from 'serve-static';
import favicon from 'serve-favicon';

import fs from 'fs-extra';
import path from 'path';

export default class LavasCore {
    constructor(cwd = process.cwd()) {
        this.cwd = cwd;
    }

    /**
     * invoked before build & runAfterBuild, do something different in each senario
     *
     * @param {string} env NODE_ENV
     * @param {boolean} isInBuild is in build process
     */
    async init(env, isInBuild) {
        this.env = env;
        this.isProd = this.env === 'production';
        this.configReader = new ConfigReader(this.cwd, this.env);

        /**
         * in a build process, we need to:
         * 1. read config by scan a directory
         * 2. validate the config
         * 3. create a webpack config for later use
         *
         * but for online server after build, we just:
         * 1. read config.json directly
         */
        if (isInBuild) {
            // scan directory
            this.config = await this.configReader.read();
            this.webpackConfig = new WebpackConfig(this.config, this.env);
        }
        else {
            // read config from config.json
            this.config = await this.configReader.readConfigFile();
        }

        /**
         * only in prod build process we don't need to use middlewares
         */
        if (!(isInBuild && this.isProd)) {
            this.internalMiddlewares = [];
            /**
             * add static files middleware only in prod mode,
             * we already have webpack-dev-middleware in dev mode
             */
            if (this.isProd) {
                this.internalMiddlewares.push(serve(this.cwd));
            }
            // serve favicon
            let faviconPath = path.join(this.cwd, 'static/img/icons', 'favicon.ico');
            this.internalMiddlewares.push(favicon(faviconPath));
        }

        // init renderer & routeManager
        this.renderer = new Renderer(this);
        this.routeManager = new RouteManager(this);
    }

    /**
     * build in dev & prod mode
     *
     */
    async build() {
        let spinner = ora();
        spinner.start();

        // clear dist/
        await fs.emptyDir(this.config.webpack.base.output.path);

        // build routes' info and source code
        await this.routeManager.buildRoutes();
        // add routes to config which will be used by service worker
        this.config.routes = this.routeManager.routes;

        // add extension's hooks
        // if (this.config.extensions) {
        //     this.config.extensions.forEach(({name, init}) => {
        //         console.log(`[Lavas] ${name} extension is running...`);
        //         this.webpackConfig.addHooks(init);
        //     });
        // }

        // webpack client & server config
        let clientConfig = this.webpackConfig.client(this.config);
        let serverConfig = this.webpackConfig.server(this.config);

        // build bundle renderer
        await this.renderer.build(clientConfig, serverConfig);

        if (this.isProd) {
            /**
             * when running online server, renderer needs to use template and
             * replace some variables such as meta, config in it. so we need
             * to store some props in config.json.
             * TODO: not all the props in config is needed. for now, only manifest
             * & assetsDir are required. some props such as globalDir are useless.
             */
            await Promise.all([
                this.configReader.writeConfigFile(this.config),
                // compile multi entries only in production mode
                this.routeManager.buildMultiEntries(),
                // store routes info in routes.json for later use
                this.routeManager.writeRoutesFile(),
                // copy to /dist
                this._copyServerModuleToDist()
            ]);
        }
        // else {
            // TODO: use chokidar to rebuild routes in dev mode
            // let pagesDir = join(this.config.globals.rootDir, 'pages');
            // chokidar.watch(pagesDir)
            //     .on('change', async () => {
            //         await this.routeManager.buildRoutes();
            //     });
        // }

        spinner.succeed(`[Lavas] ${this.env} build is completed.`);
    }

    /**
     * must run after build in prod mode
     *
     */
    async runAfterBuild() {
        await Promise.all([
            // create with routes.json
            this.routeManager.createWithRoutesFile(),
            // create with bundle & manifest
            this.renderer.createWithBundle()
        ]);
    }

    /**
     * compose all the middlewares
     *
     * @return {Function} koa middleware
     */
    koaMiddleware() {
        // transform express/connect style middleware to koa style
        return composeKoa([
            koaErrorFactory(this),
            async function (ctx, next) {
                // koa defaults to 404 when it sees that status is unset
                ctx.status = 200;
                await next();
            },
            c2k(privateFileFactory(this)),
            ...this.internalMiddlewares.map(c2k),
            c2k(ssrFactory(this))
        ]);
    }

    /**
     * compose all the middlewares
     *
     * @return {Function} express middleware
     */
    expressMiddleware() {
        return composeMiddleware.compose([
            privateFileFactory(this),
            ...this.internalMiddlewares,
            ssrFactory(this),
            expressErrorFactory(this)
        ]);
    }

    /**
     * copy server relatived files into dist when build
     */
    async _copyServerModuleToDist() {
        let distPath = this.config.webpack.base.output.path;

        let libDir = path.join(this.cwd, 'lib');
        let distLibDir = path.join(distPath, 'lib');

        let serverDir = path.join(this.cwd, 'server.dev.js');
        let distServerDir = path.join(distPath, 'server.js');

        let nodeModulesDir = path.join(this.cwd, 'node_modules');
        let distNodeModulesDir = path.join(distPath, 'node_modules');

        let jsonDir = path.join(this.cwd, 'package.json');
        let distJsonDir = path.join(distPath, 'package.json');

        await Promise.all([
            fs.copy(libDir, distLibDir),
            fs.copy(serverDir, distServerDir),
            fs.copy(nodeModulesDir, distNodeModulesDir),
            fs.copy(jsonDir, distJsonDir)
        ]);
    }
}
