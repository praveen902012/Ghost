#!/usr/bin/env node

/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');

const concurrently = require('concurrently');
const detectIndent = require('detect-indent');
const detectNewline = require('detect-newline');
const findRoot = require('find-root');
const {flattenDeep} = require('lodash');
const glob = require('glob');

const DETECT_TRAILING_WHITESPACE = /\s+$/;

const jsonFiles = new Map();

class JSONFile {
    /**
     * @param {string} filePath
     * @returns {JSONFile}
     */
    static for(filePath) {
        if (jsonFiles.has(filePath)) {
            return jsonFiles.get(filePath);
        }

        let jsonFile = new this(filePath);
        jsonFiles.set(filePath, jsonFile);

        return jsonFile;
    }

    /**
     * @param {string} filename
     */
    constructor(filename) {
        this.filename = filename;
        this.reload();
    }

    reload() {
        const contents = fs.readFileSync(this.filename, {encoding: 'utf8'});

        this.pkg = JSON.parse(contents);
        this.lineEndings = detectNewline(contents);
        this.indent = detectIndent(contents).amount;

        let trailingWhitespace = DETECT_TRAILING_WHITESPACE.exec(contents);
        this.trailingWhitespace = trailingWhitespace ? trailingWhitespace : '';
    }

    write() {
        let contents = JSON.stringify(this.pkg, null, this.indent).replace(/\n/g, this.lineEndings);

        fs.writeFileSync(this.filename, contents + this.trailingWhitespace, {encoding: 'utf8'});
    }
}

/**
 * @param {string} dir
 * @returns {string[]|null}
 */
function getWorkspacePackages(dir) {
    // pnpm: read from pnpm-workspace.yaml
    const pnpmWorkspace = path.join(dir, 'pnpm-workspace.yaml');
    if (fs.existsSync(pnpmWorkspace)) {
        const content = fs.readFileSync(pnpmWorkspace, 'utf8');
        const packages = [];
        let inPackages = false;
        for (const line of content.split('\n')) {
            if (/^packages:/.test(line)) {
                inPackages = true;
                continue;
            }
            if (inPackages) {
                const match = line.match(/^\s+-\s+['"]?([^'"]+)['"]?\s*$/);
                if (match) {
                    packages.push(match[1]);
                } else if (/^\S/.test(line)) {
                    break;
                }
            }
        }
        if (packages.length > 0) {
            return packages;
        }
    }

    // Fallback: yarn/npm workspaces field in package.json
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
        const packageJson = require(pkg);
        if ('workspaces' in packageJson) {
            const {workspaces} = packageJson;
            if (Array.isArray(workspaces)) {
                return workspaces;
            }
            return workspaces.packages || null;
        }
    }

    return null;
}

/**
 * @param {string} from
 * @returns {string[]}
 */
function getWorkspaces(from) {
    const root = findRoot(from, (dir) => {
        return getWorkspacePackages(dir) !== null;
    });

    const packages = getWorkspacePackages(root);
    return flattenDeep(packages.map(name => glob.sync(path.join(root, `${name}/`))));
}

(async () => {
    const cwd = process.cwd();
    const nearestPkgJson = findRoot(cwd);
    console.log('nearestPkgJson', nearestPkgJson);
    const pkgInfo = JSONFile.for(path.join(nearestPkgJson, 'package.json'));

    if (pkgInfo.pkg.name !== 'ghost') {
        console.log('This script must be run from the `ghost` npm package directory');
        process.exit(1);
    }

    const bundlePath = './components';
    if (!fs.existsSync(bundlePath)){
        fs.mkdirSync(bundlePath);
    }

    const workspaces = getWorkspaces(cwd)
        .filter(w => !w.startsWith(cwd) && fs.existsSync(path.join(w, 'package.json')))
        .filter(w => !w.includes('apps/'))
        .filter(w => !w.includes('/admin/'))
        .filter(w => !w.includes('/e2e/'));

    console.log('workspaces', workspaces);
    console.log('\n-------------------------\n');

    const packagesToPack = [];

    for (const w of workspaces) {
        const workspacePkgInfo = JSONFile.for(path.join(w, 'package.json'));

        if (!workspacePkgInfo.pkg.private) {
            continue;
        }

        workspacePkgInfo.pkg.version = pkgInfo.pkg.version;
        workspacePkgInfo.write();

        const slugifiedName = workspacePkgInfo.pkg.name.replace(/@/g, '').replace(/\//g, '-');
        const packedFilename = `file:` + path.join(bundlePath, `${slugifiedName}-${workspacePkgInfo.pkg.version}.tgz`);

        if (pkgInfo.pkg.dependencies[workspacePkgInfo.pkg.name]) {
            console.log(`[${workspacePkgInfo.pkg.name}] dependencies override => ${packedFilename}`);
            pkgInfo.pkg.dependencies[workspacePkgInfo.pkg.name] = packedFilename;
        }

        if (pkgInfo.pkg.devDependencies[workspacePkgInfo.pkg.name]) {
            console.log(`[${workspacePkgInfo.pkg.name}] devDependencies override => ${packedFilename}`);
            pkgInfo.pkg.devDependencies[workspacePkgInfo.pkg.name] = packedFilename;
        }

        if (pkgInfo.pkg.optionalDependencies[workspacePkgInfo.pkg.name]) {
            console.log(`[${workspacePkgInfo.pkg.name}] optionalDependencies override => ${packedFilename}`);
            pkgInfo.pkg.optionalDependencies[workspacePkgInfo.pkg.name] = packedFilename;
        }

        console.log(`[${workspacePkgInfo.pkg.name}] resolution override => ${packedFilename}\n`);
        if (!pkgInfo.pkg.resolutions) {
            pkgInfo.pkg.resolutions = {};
        }
        pkgInfo.pkg.resolutions[workspacePkgInfo.pkg.name] = packedFilename;

        packagesToPack.push(w);
    }

    // Copy pnpm.overrides from the root workspace package.json so that
    // production installs (e.g. inside Docker) pin the same versions as
    // the workspace — without these, transitive deps like moment-timezone
    // may resolve a different moment instance than ghost/core declares.
    const rootPkgPath = path.join(findRoot(path.dirname(nearestPkgJson)), 'package.json');
    const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
    if (rootPkg.pnpm && rootPkg.pnpm.overrides) {
        // Collect workspace package names so we can skip their overrides
        // (they are already referenced as file:components/*.tgz dependencies)
        const workspaceNames = new Set(workspaces
            .map((w) => {
                const wpkg = path.join(w, 'package.json');
                return fs.existsSync(wpkg) ? JSON.parse(fs.readFileSync(wpkg, 'utf8')).name : null;
            })
            .filter(Boolean));

        const filteredOverrides = {};
        for (const [key, value] of Object.entries(rootPkg.pnpm.overrides)) {
            if (!workspaceNames.has(key)) {
                filteredOverrides[key] = value;
            }
        }

        if (!pkgInfo.pkg.pnpm) {
            pkgInfo.pkg.pnpm = {};
        }
        pkgInfo.pkg.pnpm.overrides = Object.assign(
            {},
            filteredOverrides,
            pkgInfo.pkg.pnpm.overrides
        );
        console.log('Copied pnpm.overrides from root:', Object.keys(pkgInfo.pkg.pnpm.overrides).join(', '));
    }

    // Copy pnpm.onlyBuiltDependencies so that native addons (e.g. sqlite3)
    // are allowed to run their install scripts during production installs.
    // Without this, pnpm v10 blocks all build scripts by default.
    if (rootPkg.pnpm && rootPkg.pnpm.onlyBuiltDependencies) {
        if (!pkgInfo.pkg.pnpm) {
            pkgInfo.pkg.pnpm = {};
        }
        pkgInfo.pkg.pnpm.onlyBuiltDependencies = rootPkg.pnpm.onlyBuiltDependencies;
        console.log('Copied pnpm.onlyBuiltDependencies from root:', pkgInfo.pkg.pnpm.onlyBuiltDependencies.join(', '));
    }

    pkgInfo.write();

    const {result} = concurrently(packagesToPack.map(w => ({
        name: w,
        cwd: w,
        command: 'npm pack --pack-destination ../core/components'
    })));

    try {
        await result;
    } catch (e) {
        console.error(e);
        throw e;
    }

    const filesToCopy = [
        'README.md',
        'LICENSE',
        'pnpm-lock.yaml'
    ];

    for (const file of filesToCopy) {
        console.log(`copying ../../${file} to ${file}`);
        fs.copyFileSync(path.join('../../', file), file);
    }
})();
