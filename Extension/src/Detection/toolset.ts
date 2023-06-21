/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable prefer-const */

import { unlinkSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { delimiter, dirname } from 'path';
import { path, tmpFile } from '../Utility/Filesystem/path';
import { cmdlineToArray, Command, CommandFunction } from '../Utility/Process/program';
import { is } from '../Utility/System/guards';
import { evaluateExpression, recursiveRender, render } from '../Utility/Text/tagged-literal';
import { formatIntellisenseBlock } from './definition';

import { CppStandard, CStandard, DeepPartial, DefinitionFile, Intellisense, IntellisenseConfiguration, Language, OneOrMore } from './interfaces';
import { mergeObjects } from './object-merge';
import { getActions, strings } from './strings';

function isC(language?: string): boolean {
    return language === 'c';
}

function isCpp(language?: string): boolean {
    return language === 'cpp' || language === 'c++';
}

/**
 * The Toolset is the final results of the [discovery+query] process
 *
 * This is the contents that we're going to eventually pass to the back end.
 */
export class Toolset {
    cachedQueries = new Map<string, string>();
    cachedAnalysis = new Map<string, IntellisenseConfiguration>();

    cmd: Promise<CommandFunction>;
    rxResolver: (prefix: string, expression: string) => any;
    get default() {
        return this.definition.intellisense as Intellisense;
    }

    get version() {
        return this.definition.version || this.definition.intellisense?.version;
    }

    constructor(readonly compilerPath: string, readonly definition: DefinitionFile, private resolver: (prefix: string, expression: string) => any) {
        this.definition.intellisense = this.definition.intellisense || {};
        this.cmd = new Command(this.compilerPath, { env: { PATH: `${dirname(this.compilerPath)}${delimiter}${process.env.PATH}` } });

        this.rxResolver = (prefix: string, expression: string) => {
            if (!prefix) {
                switch (expression.toLowerCase()) {
                    case '-/':
                    case '/-':
                        return '[\\-\\/]';

                    case 'key':
                        return '(?<key>[^=]+)';

                    case 'value':
                        return '(?<value>.+)';

                    case 'keyEqualsValue':
                        return '(?<key>[^=]+)=(?<value>.+)';
                }
            }

            return this.resolver(prefix, expression);
        };
    }

    applyToConfiguration(intellisenseConfiguration: IntellisenseConfiguration | Intellisense, partial: DeepPartial<IntellisenseConfiguration>, data: Record<string, any> = intellisenseConfiguration) {
        mergeObjects(intellisenseConfiguration, recursiveRender(formatIntellisenseBlock(partial), data, this.resolver));
    }

    async query(command: string, queries: Record<string, DeepPartial<IntellisenseConfiguration>>, intellisenseConfiguration: IntellisenseConfiguration) {
        // check if we've handled this command before.
        const key = render(command, {}, this.resolver);
        let text = this.cachedQueries.get(key);

        if (!text) {
            // prepare the command to run
            const cmd = await this.cmd;
            const tmpFiles = new Array<string>();
            let stdout = '';
            let stderr = '';

            const commandLine = render(command, {}, (prefix, expression) => {
                if (prefix === 'tmp') {
                    // creating temp files
                    const tmp = tmpFile('tmp.', `.${expression}`);
                    writeFileSync(tmp, '');
                    tmpFiles.push(tmp);
                    switch (expression) {
                        case 'stdout':
                            stdout = tmp;
                            break;
                        case 'stderr':
                            stderr = tmp;
                            break;
                    }
                    return tmp;
                }
                return this.resolver(prefix, expression);
            });

            // parse the arguments and replace any tmp files with actual files
            const args = cmdlineToArray(commandLine);
            // execute the command line now.
            const out = await cmd(...args);
            text = [...out.console.all(), ...out.error.all()].join('\n');

            if (stdout) {
                text += await readFile(stdout, 'utf8');
            }
            if (stderr) {
                text += await readFile(stderr, 'utf8');
            }

            // remove the temp files
            tmpFiles.forEach(each => unlinkSync(each));
        }

        // now we can process the queries
        for (const [rxes, isense] of Object.entries(queries)) {
            for (const rx of strings(rxes)) {
                for (const match of [...text.matchAll(new RegExp(rx, 'gm'))]) {
                    if (match?.groups) {
                        // transform multi-line values into arrays
                        const data = {} as Record<string, any>;

                        for (let [variable, value] of Object.entries(match.groups)) {
                            value = value || '';
                            data[variable] = value.includes('\n') ?
                                value.split('\n').map(each => each.trim()).filter(each => each) :
                                value;
                        }

                        this.applyToConfiguration(intellisenseConfiguration, isense, data);
                    }
                }
            }
        }
    }

    async runTasks(block: OneOrMore<string>, commandLineArgs: string[]) {
        for (const task of strings(block)) {
            switch (task) {
                case 'inline-environment-variables':
                    const CL = process.env.CL;
                    const _CL_ = process.env['_CL_'];
                    if (CL) {
                        commandLineArgs.push(...cmdlineToArray(CL));
                    }
                    if (_CL_) {
                        commandLineArgs.unshift(...cmdlineToArray(_CL_));
                    }
                    break;
                case 'inline-response-file':
                    // scan thru the command line arguments and look for @file
                    // and replace it with the contents of the file
                    for (let i = 0; i < commandLineArgs.length; i++) {
                        if (commandLineArgs[i].startsWith('@')) {
                            const file = commandLineArgs[i].slice(1);
                            const contents = await readFile(file, 'utf8');
                            commandLineArgs.splice(i, 1, ...cmdlineToArray(contents));
                        }
                    }
                    break;

                case 'consume-lib-path':

                    break;

                case 'remove-linker-arguments':
                    const link = commandLineArgs.findIndex(each => /^[\/-]link$/i.exec(each));
                    if (link !== -1) {
                        commandLineArgs.length = link; // drop it and all that follow
                    }
                    break;

                case 'zwCommandLineSwitch':
                    break;

                case 'experimentalModuleNegative':
                    break;

                case 'verifyIncludes':
                    break;
            }
        }
    }

    processComamndLineArgs(block: Record<string, any>, commandLineArgs: string[], intellisenseConfiguration: IntellisenseConfiguration, flags: Map<string, any>) {
        // get all the regular expressions and the results to apply
        const allEngineeredRegexes: [RegExp[], any][] = Object.entries(block).map(([engineeredRx, result]) => [engineeredRx.split(';').map(rx => new RegExp(render(`^${rx}$`, {}, this.rxResolver))), result]);
        const keptArgs = new Array<string>();

        nextArg:
        while (commandLineArgs.length) {
            nextRx:
            for (const [engineeredRegexSet, isense] of allEngineeredRegexes) {
                const capturedData = {};
                for (const result of engineeredRegexSet.map((rx, index) => rx.exec(commandLineArgs[index]))) {
                    if (result === null) {
                        continue nextRx; // something didn't match, we don't care.
                    }
                    if (result.groups) {
                        mergeObjects(capturedData, result.groups);
                    }
                }
                // now we can apply the results to the intellisenseConfiguration
                this.applyToConfiguration(intellisenseConfiguration, isense, capturedData);

                // remove the args used from the command line
                const usedArgs = commandLineArgs.slice(0, engineeredRegexSet.length);

                // but if the no_consume flag set, we should keep the args in the KeptArgs list
                if (!flags.get('no_consume')) {
                    // remove the arguments from the command line
                    keptArgs.push(...usedArgs);
                }
                continue nextArg;
            }

            // if we got here after running the expressions, we did not have a match.
            // so we can just assume that something else will look at them later
            keptArgs.push(commandLineArgs.shift()!);
        }
        return keptArgs;
    }

    async ensurePathsAreLegit(obj: Record<string, any>) {
        for (let [key, value] of Object.entries(obj)) {
            const k = key.toLowerCase();
            // if it's a *path(s), let's make sure they are real
            if (['path', 'paths', 'file', 'files'].find(each => k.endsWith(each))) {
                if (is.string(value)) {
                    // if we started with a string, let's check if it's a concatenated path first.
                    const values = value.split(delimiter);
                    if (values.length <= 1) {
                        obj[key] = await path.exists(render(value as string, {}, this.resolver)) || value;
                        continue;
                    }

                    // concatenated path (with delimiters)
                    value = values;
                }

                // if it's an array, let's check each value now.
                if (is.array(value)) {
                    obj[key] = [...new Set(await Promise.all(value.map(each => each && path.exists(render(each as string, {}, this.resolver)))))].filter(each => each);
                }
            }

            // if it's a nested object, let's recurse
            if (is.object(value)) {
                await this.ensurePathsAreLegit(value);
            }
        }
    }

    /**
     * Processes the analysis section of the definition file given a command line to work with
     */
    async getIntellisenseConfiguration(compilerArgs: string[], options?: { baseDirectory?: string; sourceFile?: string; language?: Language; standard?: CppStandard | CStandard; userIntellisenseConfiguration?: IntellisenseConfiguration }): Promise<IntellisenseConfiguration> {
        let intellisenseConfiguration = this.cachedAnalysis.get(compilerArgs.join(' '));
        if (intellisenseConfiguration) {
            // after getting the cached results, merge in user settings (which are not cached here)
            if (options?.userIntellisenseConfiguration) {
                this.applyToConfiguration(intellisenseConfiguration, options.userIntellisenseConfiguration);

                // before we go, let's make sure that any *paths are unique, and that they are all absolute
                await this.ensurePathsAreLegit(intellisenseConfiguration);
            }
            return intellisenseConfiguration;
        }

        intellisenseConfiguration = {
            ...this.definition.intellisense,
            language: options?.language,
            standard: options?.standard,
            compilerPath: this.compilerPath
        } as IntellisenseConfiguration;

        // no analysis? nothing to do then. (really?)
        if (!this.definition.analysis) {
            return intellisenseConfiguration;
        }

        const entries = getActions<Record<string, IntellisenseConfiguration>>(this.definition.analysis as any, [
            ['task', ['priority', 'c', 'cpp', 'c++']],
            ['command', ['priority', 'c', 'cpp', 'c++', 'no_consume']],
            ['quer', ['priority', 'c', 'cpp', 'c++']],
            ['expression', ['priority', 'c', 'cpp', 'c++']]
        ]);
        // process the entries in priority order
        for (const { action, block, flags } of entries) {
            // If the flags specifies 'C' and the language is not 'c', then we should skip this section.
            if (flags.get('c') && !isC(intellisenseConfiguration.lanugage)) {
                continue;
            }

            // If the flags specifies 'c++' and the language is not 'c++', then we should skip this section.
            if ((flags.get('cpp') || flags.get('c++') && !isCpp(intellisenseConfiguration.lanugage))) {
                continue;
            }

            switch (action) {
                case 'task':
                    await this.runTasks(block as unknown as OneOrMore<string>, compilerArgs /* , intellisenseConfiguration */);
                    break;

                case 'command':
                    compilerArgs = this.processComamndLineArgs(block, compilerArgs, intellisenseConfiguration, flags);
                    break;

                case 'quer':
                    for (const [command, queries] of Object.entries(block as Record<string, Record<string, DeepPartial<IntellisenseConfiguration>>>)) {
                        await this.query(command, queries, intellisenseConfiguration);
                    }
                    break;

                case 'expression':
                    for (const [expr, isense] of Object.entries(block as Record<string, DeepPartial<IntellisenseConfiguration>>)) {
                        if (evaluateExpression(expr, intellisenseConfiguration, this.resolver)) {
                            this.applyToConfiguration(intellisenseConfiguration, isense);
                        }
                    }
                    break;
                default:
                    break;
            }
        }

        // before we go, let's make sure that any *paths are unique, and that they are all absolute
        await this.ensurePathsAreLegit(intellisenseConfiguration);

        // render any variables that are left (if therer are value that are specified explicity in definition that reference variables, this is when they get resolved)
        intellisenseConfiguration = recursiveRender(intellisenseConfiguration, intellisenseConfiguration, this.resolver);

        // cache the results
        this.cachedAnalysis.set(compilerArgs.join(' '), intellisenseConfiguration);

        // after the cached results, merge in user settings (since the yuser can change those at any time)
        if (options?.userIntellisenseConfiguration) {
            this.applyToConfiguration(intellisenseConfiguration, options.userIntellisenseConfiguration);

            // before we go, let's make sure that any *paths are unique, and that they are all absolute
            await this.ensurePathsAreLegit(intellisenseConfiguration);
        }

        return intellisenseConfiguration;
    }
}
