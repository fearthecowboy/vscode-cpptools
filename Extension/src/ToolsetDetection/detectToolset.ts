/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as os from 'os';
import { basename, resolve } from 'path';
import { rcompare } from 'semver';

import { parse } from 'comment-json';
import { readFile } from 'fs/promises';
import { accumulator } from '../Utility/Async/iterators';
import { ManualPromise } from '../Utility/Async/manualPromise';
import { then } from '../Utility/Async/sleep';
import { filepath, filterToFolders, pathsFromVariable } from '../Utility/Filesystem/filepath';
import { FastFinder, ripGrep } from '../Utility/Filesystem/ripgrep';
import { is } from '../Utility/System/guards';
import { consolelog, elapsed } from '../Utility/System/performance';
import { verbose } from '../Utility/Text/streams';
import { render } from '../Utility/Text/taggedLiteral';
import { isWindows } from '../constants';
import { loadCompilerDefinitions, resetCompilerDefinitions, runConditions } from './definition';
import { DefinitionFile, IntelliSense, IntelliSenseConfiguration } from './interfaces';
import { clone } from './objectMerge';
import { createResolver } from './resolver';
import { getActions, strings } from './strings';
import { Toolset, settings, updateDiscoveredToolsets } from './toolset';
import escapeStringRegExp = require('escape-string-regexp');

let initialized: ManualPromise | undefined;

const discoveringInProgress = new Map<DefinitionFile, Promise<void>>();
let discovering: Promise<any> | undefined;
const configurationFolders = new Set<string>();

const searchCache = new Map<string, Promise<Record<string, string> | undefined>>();

async function searchInsideBinary(compilerPath: string, rx: string | Promise<string>) {
    if (is.promise(rx)) {
        rx = await(rx);
    }
    const cc = compilerPath + rx;
    let result = searchCache.get(cc);

    async function impl() {
        for await (const match of ripGrep(compilerPath, rx as string, { binary: true, ignoreCase: true })) {
            const rxResult = new RegExp(rx as string, 'i').exec(match.lines.text.replace(/\0/g, ''));
            if (rxResult) {
                return rxResult.groups || {};
            }
        }
        return undefined;
    }
    if (!result) {
        consolelog(`${elapsed()}Running Ripgrep for ${cc}`);
        result = impl();
        searchCache.set(cc, result);
    } else {
        consolelog(`Already got value for ${cc}`);
    }
    return result;
}

async function discover(compilerPath: string, definition: DefinitionFile): Promise<Toolset | undefined> {
    // normalize the path separators to be forward slashes.
    compilerPath = resolve(compilerPath);
    consolelog(`${elapsed()} DISCOVER ${compilerPath} ${definition.name}`);

    let toolset = settings.discoveredToolsets.get(compilerPath);
    if (toolset) {
        return toolset;
    }
    // toolset was not previously discovered for this binary, so, discover it now.

    // clone the definition so it can be modified without affecting the original
    definition = clone(definition);

    // create toolset object for the result.
    toolset = new Toolset(compilerPath, definition);

    const intellisense = definition.intellisense as IntelliSense;

    const requirements = getActions<Record<string, IntelliSenseConfiguration>>(definition.discover as any, [
        ['match', ['optional', 'priority', 'oneof']],
        ['expression', ['oneof', 'optional', 'priority', 'folder', 'file']]
    ]);
    consolelog(`${elapsed()} DISCOVER (REQUIREMENTS) ${compilerPath} ${definition.name}`);
    nextBlock:
    for (const { action, block, flags } of requirements) {
        consolelog(`${elapsed()} (REQUIREMENTS ${action} ${JSON.stringify(block)}) ${compilerPath} ${definition.name}`);
        switch (action) {
            case 'match':
                // valid flags : 'oneof', 'optional'
                if (flags.has('oneof')) {
                    // run them in parallel, but take the first winning result in order
                    for (const [rawRx, isense] of Object.entries(block)) {
                        const result = await searchInsideBinary(compilerPath, render(rawRx, {}, toolset.resolver));
                        if (result) {
                            await toolset.applyToConfiguration(toolset.default, isense, result);
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
                    for (const [rawRx, isense] of Object.entries(block)) {
                        const r = await searchInsideBinary(compilerPath, render(rawRx, {}, toolset.resolver));
                        if (r) {
                            await toolset.applyToConfiguration(toolset.default, isense, r);
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
                    const value = await render(expr, {}, toolset.resolver);
                    if (value) {
                        if (flags.has('folder')) {
                            if (await filepath.isFolder(value)) {
                                await toolset.applyToConfiguration(intellisense, isense);
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
                                await toolset.applyToConfiguration(intellisense, isense);
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
                        await toolset.applyToConfiguration(intellisense, isense);
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
    consolelog(`${elapsed()} DISCOVER (DONE REQUIREMENTS) ${compilerPath} ${definition.name}`);

    settings.discoveredToolsets.set(compilerPath, toolset);
    void updateDiscoveredToolsets();

    return toolset;
}

async function loadCachedEntries() {
    if (!settings.globalStoragePath) {
        return false;
    }

    const cachePath = await filepath.isFile(resolve(settings.globalStoragePath, 'detected-toolsets.json'));
    if (!cachePath) {
        return false;
    }

    const entries = parse(await readFile(cachePath, 'utf8')) as Record<string, any>;
    if (!is.object(entries)) {
        return false;
    }

    for (const [path, obj] of Object.entries(entries)) {
        const toolset = Toolset.deserialize(obj);
        if (toolset) {
            consolelog(`${elapsed()} loaded cached entry for ${path} - ${toolset.name}`);
            settings.discoveredToolsets.set(path, toolset);
        }
    }

    // candidate: string
    /*
    ... consolelog(`${elapsed()} about to identify ${entries.length} cached entries`);
    const all = [];
    for (const [path, name] of Object.entries(entries)) {
        const fileInfo = await filepath.info(path);
        if (fileInfo?.isExecutable) {
            all.push(identify(path, name));
        }
    }
    await Promise.all(all);
    consolelog(`${elapsed()} loaded cached entries`);
    */
    return true;
}

/**
 * This will search for toolsets based on the definitions
 * Calling this forces a reset of the compiler definitions and discovered toolsets -- ideally this shouldn't need to be called
 * more than the initial time
 */
export async function initialize(configFolders: string[], options?: { quick?: boolean; storagePath?: string }) {
    if (initialized) {
        // wait for an existing initialize to complete
        await initialized;
    }

    consolelog(`${elapsed()} initializing compiler detection`);

    initialized = new ManualPromise();

    const forceReset = !options?.quick;

    settings.globalStoragePath = options?.storagePath;

    if (forceReset) {
        // if initialize is called more than once, we need to reset the compiler definitions and list of discovered toolsets
        // (options.quick=true should only be used with tests)
        resetCompilerDefinitions();
        settings.discoveredToolsets.clear();
        discoveringInProgress.clear();
    }

    // add the configuration folders to the list of folders to scan
    configFolders.forEach(each => configurationFolders.add(each));

    consolelog(`${elapsed()} Before loading cached info`);
    await loadCachedEntries();
    consolelog(`${elapsed()} loaded cached files`);

    if (forceReset) {
        // start searching now in the background if we've just reset everything
        // void getToolsets();
    }
    initialized.resolve();

    return settings.discoveredToolsets;
}

/**
 * Async scan for all compilers using the definitions (toolset.*.json) in the given folders
 * (iterate over this with `for await`)
 *
 * UNUSED-- TARGET FOR DELETION
 * /
export async function* detectToolsets(): AsyncIterable<Toolset> {
    const results = accumulator<Toolset>();
    for await (const definition of loadCompilerDefinitions(configurationFolders)) {
        results.add(searchForToolsets(definition));
    }
    results.complete();
    yield* results;
}
*/

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

    // ensure that init is done
    await initialized;

    // this exponentially/asychnronously searches for toolsets using the configuration folders
    for await (const definition of loadCompilerDefinitions(configurationFolders)) {
        // have we started searching with this definition yet?
        const searching = discoveringInProgress.get(definition);

        // yeah, we're already searching, so skip this one
        if (is.promise(searching)) {
            continue;
        }
        // nope, we haven't started searching yet, so start it now
        discoveringInProgress.set(definition, then(async () => {
            for await (const toolset of searchForToolsets(definition)) {
                if (toolset) {
                    verbose(`Detected Compiler ${toolset.name}`);
                }
            }
        }));
    }
    // wait for the inProgress searches to complete
    discovering = Promise.all(discoveringInProgress.values());

    await discovering;

    // return the results
    return settings.discoveredToolsets;
}

function lookupToolset(name: string) {
    // check if the candidate is a name of a toolset (* AND ? are supported)
    const rx = new RegExp(escapeStringRegExp(name).replace(/\\\*/g, '.*'));

    // iterate over the discovered toolsets starting with the highest versions
    for (const toolset of [...settings.discoveredToolsets.values()].sort((a, b) => rcompare(a.version ?? "0.0.0", b.version ?? "0.0.0"))) {
        // return the first match given the regex
        if (rx.exec(toolset.name)) {
            consolelog(`${elapsed()} found toolset ${toolset.name} for ${name}`);
            return toolset;
        }
    }
}

const identifyInProgress = new Map<string, Promise<Toolset | undefined>>();

/**
 * Given a path to a binary, identify the compiler
 * @param candidate the path to the binary to identify
 * @returns a Toolset or undefined.
 */
export async function identifyToolset(candidate: string): Promise<Toolset | undefined> {
    if (!initialized) {
        throw new Error('Compiler detection has not been initialized. Call initialize() before calling this.');
    }

    // quick check if the given path is already in the discovered toolsets
    const toolset = settings.discoveredToolsets.get(candidate);
    if (toolset) {
        return toolset;
    }

    // check if we're already identifying this candidate
    if (identifyInProgress.get(candidate)) {
        return identifyInProgress.get(candidate);
    }

    // set this candidate to in-progress.
    const promise = new ManualPromise<Toolset | undefined>();
    identifyInProgress.set(candidate, promise);

    // get file info for the candidate (is it even a file?)
    const fileInfo = await filepath.info(candidate);

    if (!fileInfo?.isFile) {
        // ensure that init is done
        await initialized;

        consolelog(`${elapsed()} looking up toolset ${candidate}`);

        // if it's not a file let's quickly check for a match in the discovered toolsets
        const toolset = lookupToolset(candidate);
        if (toolset) {
            return toolset;
        }

        consolelog(`${elapsed()} Didn't find entry for toolset ${candidate}`);
        // we didn't find it, but the discovery may not be done yet, or hasn't been done.

        consolelog(`${elapsed()} Checking if discovery is done`);
        // make sure discovery is done before doing another lookup.
        await (is.promise(discovering) ? discovering : getToolsets());

        return lookupToolset(candidate);
    }

    if (fileInfo.isExecutable) {
        // otherwise, let's use the definitions to try to identify it.
        return identify(candidate).then((result) => {promise.resolve(result); return promise;});
    }
    // otherwise...
    promise.resolve(undefined);
    return undefined;
}

async function identify(candidate: string, name?: string): Promise<Toolset | undefined> {
    const bn = basename(candidate);
    consolelog(`Identify ${candidate} ${name} ${bn}`);
    for await (const definition of loadCompilerDefinitions(configurationFolders)) {
        if (!name || definition.name === name){
            consolelog(`${elapsed()} Checking ${candidate} against ${definition.name}`);
            const resolver = createResolver(definition);
            await runConditions(definition, resolver);

            if (strings(definition.discover.binary).includes(basename(bn, isWindows ? '.exe' : undefined))) {
                consolelog(`${elapsed()} Possible Match toolset ${definition.name} for ${candidate}`);
                const toolset = await discover(candidate, definition);
                if (toolset) {
                    consolelog(`${elapsed()} Loaded toolset ${toolset.name} for ${candidate}`);
                    return toolset;
                }
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
    const resolver = createResolver(definition);
    await runConditions(definition, resolver);

    // create the finder
    const finder = new FastFinder(strings(definition.discover.binary), { executable: true, executableExtensions: ['.exe'] });

    // start scanning the folders in the $PATH
    finder.scan(...await filterToFolders(pathsFromVariable('PATH')));

    // add any folders that the definition specifies (expand any variables)
    finder.scan(10, ...await render(strings(definition.discover.locations), {}, resolver));

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
