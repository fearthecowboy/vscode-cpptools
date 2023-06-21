/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { fail } from 'assert';
import * as os from 'os';
import { homedir } from 'os';
import { basename, delimiter, resolve, sep } from 'path';
import { accumulator } from '../Utility/Async/awaiters';
import { filterToFolders, path, pathsFromVariable } from '../Utility/Filesystem/path';
import { FastFinder, initRipGrep, ripGrep } from '../Utility/Filesystem/ripgrep';
import { render } from '../Utility/Text/tagged-literal';
import { getExtensionFilePath } from '../common';
import { loadCompilerDefinitions, resetCompilerDefinitions, runConditions } from './definition';
import { DefinitionFile, Intellisense, IntellisenseConfiguration } from './interfaces';
import { clone } from './object-merge';
import { getActions, strings } from './strings';
import { Toolset } from './toolset';

function normalizePath(path: string) {
    return path.replace(/\\/g, '/');
}

function nativePath(path: string) {
    return resolve(path);
}

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
                            return (definition.intellisense as any)[expression as keyof IntellisenseConfiguration];
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

const discoveredToolsets = new Map<string, Toolset>();

async function discover(compilerPath: string, definition: DefinitionFile): Promise<Toolset | undefined> {
    // normalize the path separators to be forward slashes.
    compilerPath = normalizePath(compilerPath);

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
    toolset = new Toolset(nativePath(compilerPath), definition, resolver);

    const intellisense = definition.intellisense as Intellisense;

    const requirements = getActions<Record<string, IntellisenseConfiguration>>(definition.discover as any, [
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
                        if (await result) {
                            toolset.applyToConfiguration(toolset.default, isense, result);
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
                            if (await path.isFolder(value)) {
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
                            if (await path.isFile(value)) {
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

let initialized = false;
/**
 * This will search for toolsets based on the built-in definitions
 * Calling this forces a reset of the compiler definitions and discovered toolsets -- ideally this shouldn't need to be called
 * more than the initial time
 */
export async function initialize() {
    if (!initialized) {
        const rgPath = resolve((process as any).resourcesPath, `app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg${process.platform === 'win32' && '.exe'}`);
        const rg = await path.isExecutable(rgPath);
        if (!rg) {
            fail('ripgrep not found');
        }
        await initRipGrep(rgPath);
        initialized = true;
    }

    // if initialize is called more than once, we need to reset the compiler definitions and list of discovered toolsets
    resetCompilerDefinitions();
    discoveredToolsets.clear();

    console.log('Detecting toolsets based for built-in definitions');
    const root = getExtensionFilePath("bin/definitions");

    for await (const toolset of detectToolsets([root])) {
        console.log(`Detected Compiler ${toolset.definition.name}/${toolset.version}/TARGET:${toolset.default.architecture}/HOST:${toolset.default.hostArchitecture}/BITS:${toolset.default.bits}/${toolset.compilerPath}`);
    }

    return discoveredToolsets;
}

/**
 * Scan for all compilers using the definitions (toolset.*.json) in the given folders
 *
 * Previously discovered toolsets are cached and returned from this. (so, no perf hit for calling this multiple times)
 *
 * @param configurationFolders The folders to scan for compiler definitions
 */
export async function* detectToolsets(configurationFolders: string[]): AsyncIterable<Toolset> {
    const results = accumulator<Toolset>();
    for await (const definition of loadCompilerDefinitions(configurationFolders)) {
        results.add(searchForToolsets(definition));
    }
    results.complete();
    yield* results;
}

/**
 * Given a path to a binary, identify the compiler
 * @param candidate the path to the binary to identify
 * @param configurationFolders The folders to scan for compiler definitions
 * @returns a Toolset or undefined.
 */
export async function identifyToolset(candidate: string, configurationFolders: string[]): Promise<Toolset | undefined> {
    const fileInfo = await path.info(candidate);
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
