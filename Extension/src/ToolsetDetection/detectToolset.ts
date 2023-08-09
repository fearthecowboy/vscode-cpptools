/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { fail } from 'assert';
import * as os from 'os';
import { homedir } from 'os';
import { basename, delimiter, resolve, sep } from 'path';
import { rcompare } from 'semver';
import { accumulator } from '../Utility/Async/iterators';
import { then } from '../Utility/Async/sleep';
import { filepath, filterToFolders, pathsFromVariable } from '../Utility/Filesystem/filepath';
import { FastFinder, initRipGrep, ripGrep } from '../Utility/Filesystem/ripgrep';
import { is } from '../Utility/System/guards';
import { verbose } from '../Utility/Text/streams';
import { render } from '../Utility/Text/taggedLiteral';
import { isWindows } from '../constants';
import { loadCompilerDefinitions, resetCompilerDefinitions, runConditions } from './definition';
import { DefinitionFile, IntelliSense, IntelliSenseConfiguration } from './interfaces';
import { clone } from './objectMerge';
import { getActions, strings } from './strings';
import { Toolset } from './toolset';
import escapeStringRegExp = require('escape-string-regexp');

const discoveredToolsets = new Map<string, Toolset>();
let initialized = false;
const inProgressCache = new Map<DefinitionFile, Promise<void>>();
let discovering: Promise<any>|undefined;
const configurationFolders = new Set<string>();

function createResolver(definition: DefinitionFile, compilerPath: string) {
    return (prefix: string, expression: string) => {
        switch (prefix) {
            case 'env':
                // make sure ${env:HOME} is expanded to the user's home directory always
                if (expression.toLowerCase() === 'home') {
                    return homedir();
                }
                return process.env[expression] || '';

            case 'definition':
                return (definition as any)[expression] || '';

            case 'config':
                // get a configuration variable from vscode
                // vscode.workspace.getConfiguration().get(expression.replace(/:/g,'.'));
                return '';

            case 'host':
                switch (expression) {
                    case 'os':
                    case 'platform':
                        return os.platform;

                    case 'arch':
                    case 'architecture':
                        return os.arch();
                }
                break;

            case 'compilerPath':
                switch (expression) {
                    case 'basename':
                        return process.platform === 'win32' ? basename(compilerPath, '.exe') : basename(compilerPath);
                }
                break;

            case '':
                // todo: if they ask for a variable without a prefix, it could be a host variable -- ask vscode to resolve those
                switch (expression) {
                    case 'workspaceroot':
                    case 'workspaceRoot':
                    case 'workspaceFolder':
                    case 'workspacefolder':
                    case 'cwd': // ??
                        // get it from vscode (ie: vscode.workspace.workspaceFolders[0]?.uri.fsPath || '' );
                        return process.cwd(); // fake, this should come from the host.

                    case 'pathSeparator':
                        return sep;

                    case 'pathDelimiter':
                        return delimiter;

                    case 'name':
                        return definition.name;

                    case 'binary':
                    case 'compilerPath':
                        return compilerPath;

                    default:
                        // if the request was looking for a value in the intellisense configuration, we'll try to resolve that
                        if (definition.intellisense && expression in definition.intellisense) {
                            return (definition.intellisense as any)[expression as keyof IntelliSenseConfiguration];
                        }
                }
                break;

            default:
                return '';
        }

        return '';
    };
}

async function searchInsideBinary(compilerPath: string, rx: string) {
    for await (const match of ripGrep(compilerPath, rx, { binary: true, ignoreCase: true })) {
        const rxResult = new RegExp(rx, 'i').exec(match.lines.text.replace(/\0/g, ''));
        if (rxResult) {
            return rxResult.groups || {};
        }
    }
    return undefined;
}

async function discover(compilerPath: string, definition: DefinitionFile): Promise<Toolset | undefined> {
    // normalize the path separators to be forward slashes.
    compilerPath = resolve(compilerPath);

    let toolset = discoveredToolsets.get(compilerPath);
    if (toolset) {
        return toolset;
    }
    // toolset was not previously discovered for this binary, so, discover it now.

    // clone the definition so it can be modified without affecting the original
    definition = clone(definition);

    // resolver for variables in the definition
    const resolver = createResolver(definition, compilerPath);

    // create toolset object for the result.
    toolset = new Toolset(compilerPath, definition, resolver);

    const intellisense = definition.intellisense as IntelliSense;

    const requirements = getActions<Record<string, IntelliSenseConfiguration>>(definition.discover as any, [
        ['match', ['optional', 'priority', 'oneof']],
        ['expression', ['oneof', 'optional', 'priority', 'folder', 'file']]
    ]);
    nextBlock:
    for (const { action, block, flags } of requirements) {
        switch (action) {
            case 'match':
                // valid flags : 'oneof', 'optional'
                if (flags.has('oneof')) {
                    // run them in parallel, but take the first winning result in order
                    const results = Object.entries(block).map(([rawRx, isense]) => [searchInsideBinary(compilerPath, render(rawRx, {}, resolver)), isense] as const);
                    for (const [result, isense] of results) {
                        if (await result) {
                            toolset.applyToConfiguration(toolset.default, isense, result);
                            // first one wins, exit the block
                            // await Promise.all(results); // wait for all the results to complete?
                            continue nextBlock;
                        }
                    }
                    // if this is optional, we can move to the next entry
                    if (flags.has('optional')) {
                        continue nextBlock;
                    }
                    // if we got here, none matched, so this whole toolset is not a match
                    return;
                } else {
                    const results = Object.entries(block).map(([rawRx, isense]) => [searchInsideBinary(compilerPath, render(rawRx, {}, resolver)), isense] as const);
                    for (const [result, isense] of results) {
                        const r = await result;
                        if (r) {
                            toolset.applyToConfiguration(toolset.default, isense, r);
                            continue;
                        }
                        // not found, but not a problem
                        if (flags.has('optional')) {
                            continue;
                        }

                        // not found, and not optional, so this whole toolset is not a match
                        return;
                    }
                }
                break;

            case 'expression':
                // verifies that the expression is true
                // valid flags : 'oneof', 'optional', 'priority', 'folder', 'file'
                for (const [expr, isense] of Object.entries(block)) {
                    const value = render(expr, {}, resolver);
                    if (value) {
                        if (flags.has('folder')) {
                            if (await filepath.isFolder(value)) {
                                toolset.applyToConfiguration(intellisense, isense);
                                if (flags.has('oneof')) {
                                    // first one wins, exit the block
                                    continue nextBlock;
                                }
                                // a success, move to the next entry
                                continue;
                            }
                            // not a match
                            if (flags.has('optional') || flags.has('oneof')) {
                                // didn't find it, but it's optional (or we can still find a match later?), so we can move to the next entry
                                continue;
                            }

                            // should be a folder match, and not optional. this toolset is not a match
                            return;
                        }

                        if (flags.has('file')) {
                            if (await filepath.isFile(value)) {
                                toolset.applyToConfiguration(intellisense, isense);
                                if (flags.has('oneof')) {
                                    // first one wins, exit the block
                                    continue nextBlock;
                                }
                                // a success, move to the next entry
                                continue;
                            }

                            // not a match
                            if (flags.has('optional') || flags.has('oneof')) {
                                // didn't find it, but it's optional (or we can still find a match later?), so we can move to the next entry
                                continue;
                            }

                            // should be a file match, and not optional. this toolset is not a match
                            return;
                        }

                        // it's a truthy value, so it's a match
                        toolset.applyToConfiguration(intellisense, isense);
                        if (flags.has('oneof')) {
                            // first one wins, exit the block
                            continue nextBlock;
                        }
                        // a success, move to the next entry
                        continue;
                    }
                    // we didn't get a match
                    if (flags.has('optional') || flags.has('oneof')) {
                        // didn't find it, but it's optional (or we can still find a match later?), so we can move to the next entry
                        continue;
                    }

                    // no match, the whole toolset is not a match
                    return;
                }
                break;
        }
    }
    discoveredToolsets.set(compilerPath, toolset);
    return toolset;
}

/**
 * This will search for toolsets based on the definitions
 * Calling this forces a reset of the compiler definitions and discovered toolsets -- ideally this shouldn't need to be called
 * more than the initial time
 */
export async function initialize(configFolders: string[], rgPath?: string, forceReset = true) {
    if (!initialized) {
        rgPath = rgPath || resolve((process as any).resourcesPath, `app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg${isWindows ? '.exe' : ''}`);
        const rg = await filepath.isExecutable(rgPath);
        if (!rg) {
            fail('ripgrep not found');
        }
        await initRipGrep(rgPath);
        initialized = true;
    }

    if (forceReset) {
        // if initialize is called more than once, we need to reset the compiler definitions and list of discovered toolsets
        // (forceReset should only be used with tests)
        resetCompilerDefinitions();
        discoveredToolsets.clear();
        inProgressCache.clear();
    }

    // add the configuration folders to the list of folders to scan
    configFolders.forEach(each => configurationFolders.add(each));

    if (forceReset) {
        // start searching now in the background if we've just reset everything
        void getToolsets();
    }
    return discoveredToolsets;
}

/**
 * Async scan for all compilers using the definitions (toolset.*.json) in the given folders
 * (iterate over this with `for await`)
 */
export async function* detectToolsets(): AsyncIterable<Toolset> {
    const results = accumulator<Toolset>();
    for await (const definition of loadCompilerDefinitions(configurationFolders)) {
        results.add(searchForToolsets(definition));
    }
    results.complete();
    yield* results;
}

/** Returns the discovered toolsets all at once
 *
 * If the discovery has been done before, it will just return the cached results.
 * If it hasn't, it will run the discovery process and then return all the results.
 *
 * To reset the cache, call initialize() before calling this.
 */
export async function getToolsets() {
    if (!initialized) {
        throw new Error('Compiler detection has not been initialized. Call initialize() before calling this.');
    }

    // this exponentially/asychnronously searches for toolsets using the configuration folders
    for await (const definition of loadCompilerDefinitions(configurationFolders)) {
        // have we started searching with this definition yet?
        const searching = inProgressCache.get(definition);

        // yeah, we're already searching, so skip this one
        if (is.promise(searching)) {
            continue;
        }
        // nope, we haven't started searching yet, so start it now
        inProgressCache.set(definition, then(async () => {
            for await (const toolset of searchForToolsets(definition)) {
                if (toolset) {
                    verbose(`Detected Compiler ${toolset.name}`);
                }
            }
        }));
    }
    // wait for the inProgress searches to complete
    discovering = Promise.all(inProgressCache.values());

    await discovering;

    // return the results
    return discoveredToolsets;
}

/**
 * Given a path to a binary, identify the compiler
 * @param candidate the path to the binary to identify
 * @returns a Toolset or undefined.
 */
export async function identifyToolset(candidate: string): Promise<Toolset | undefined> {
    if (!initialized) {
        throw new Error('Compiler detection has not been initialized. Call initialize() before calling this.');
    }
    const fileInfo = await filepath.info(candidate);

    if (!fileInfo?.isFile) {
        // they are passing in a non-file so we have to
        // make sure discovery is done before looking in the cache.
        await (is.promise(discovering) ? discovering : getToolsets());

        // it's not a file, but it might be a toolset name
        // check if the candidate is a name of a toolset (* AND ? are supported)
        const rx = new RegExp(escapeStringRegExp(candidate).replace(/\\\*/g, '.*'));

        // iterate over the discovered toolsets starting with the highest versions
        for (const toolset of [...discoveredToolsets.values()].sort((a, b) => rcompare(a.version ?? "0.0.0", b.version ?? "0.0.0"))) {

            // return the first match given the regex
            if (rx.exec(toolset.name)) {
                return toolset;
            }
        }

        // since they didn't pass in a file, and it's not a toolset name, we can't find it
        return undefined;
    }

    // check if the given path is already in the cache
    const cached = discoveredToolsets.get(candidate);
    if (cached) {
        return cached;
    }

    for await (const definition of loadCompilerDefinitions(configurationFolders)) {
        const resolver = createResolver(definition, '');
        runConditions(definition, resolver);

        if (fileInfo?.isExecutable && strings(definition.discover.binary).includes(fileInfo.basename)) {
            const toolset = await discover(candidate, definition);
            if (toolset) {
                return toolset;
            }
        }
    }
    return undefined;
}

/** Given a specific definition file, detect a compiler
 *
 * If a path to candidate is passed in then we will only check that path.
 *
 * Otherwise, it will scan the $PATH, $ProgramFiles* and locations specified in the definition file.
 */
async function* searchForToolsets(definition: DefinitionFile): AsyncIterable<Toolset | undefined> {
    // run the conditions once before we start.
    const resolver = createResolver(definition, '');
    runConditions(definition, resolver);

    // create the finder
    const finder = new FastFinder(strings(definition.discover.binary), { executable: true, executableExtensions: ['.exe'] });

    // start scanning the folders in the $PATH
    finder.scan(...await filterToFolders(pathsFromVariable('PATH')));

    // add any folders that the definition specifies (expand any variables)
    finder.scan(10, ...render(strings(definition.discover.locations), {}, resolver));

    // add any platform folders
    switch (os.platform()) {
        case 'win32':
            finder.scan(10, ...['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)', 'ProgramFiles(Arm)'].map(each => process.env[each]).filter(each => each) as string[]);
            break;
        case 'linux':
            finder.scan(10, '/usr/lib/');
            break;
        case 'darwin':
            break;
    }

    const results = accumulator<Toolset>();

    // kick off each discovery asynchronously
    for await (const compilerPath of finder) {
        results.add(discover(compilerPath, definition));
    }
    results.complete();

    // return them as they complete.
    yield* results;
}
