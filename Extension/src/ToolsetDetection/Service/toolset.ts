/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable prefer-const */

import { unlinkSync, writeFileSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { delimiter, dirname, resolve } from 'path';
import { filepath, mkdir, tmpFile } from '../../Utility/Filesystem/filepath';
import { cmdlineToArray, Command, CommandFunction } from '../../Utility/Process/program';
import { is } from '../../Utility/System/guards';
import { CustomResolver, evaluateExpression, recursiveRender, render } from '../../Utility/Text/taggedLiteral';
import { formatIntelliSenseBlock } from './definition';

import { Cache } from '../../Utility/System/cache';
import { structuredClone } from '../../Utility/System/structuredClone';
import { CppStandard, CStandard, DeepPartial, DefinitionFile, FullIntellisenseConfiguration, IntelliSense, IntelliSenseConfiguration, Language, OneOrMore } from '../interfaces';
import { mergeObjects } from './objectMerge';
import { createResolver } from './resolver';
import { getActions, strings } from './strings';

function isC(language?: string): boolean {
    return language === 'c';
}

function isCpp(language?: string): boolean {
    return language === 'cpp' || language === 'c++';
}

export let settings = {
    globalStoragePath:  undefined as string | undefined,
    discoveredToolsets: new Map<string, Toolset>()
};

export async function updateDiscoveredToolsets() {
    if (settings.globalStoragePath) {
        await mkdir(settings.globalStoragePath);
        const contents = {} as Record<string, any>;
        for (const [path, toolset] of settings.discoveredToolsets.entries()) {
            contents[path] = toolset.serialize();
        }

        await writeFile(resolve(settings.globalStoragePath, 'detected-toolsets.json'), JSON.stringify(contents));
    }
}

/**
 * The Toolset is the final results of the [discovery+query] process
 *
 * This is the contents that we're going to eventually pass to the back end.
 */
export class Toolset {
    cachedQueries = new Cache<string>();
    cachedAnalysis = new Cache<FullIntellisenseConfiguration>();
    resolver: CustomResolver;
    cmd: Promise<CommandFunction>;
    rxResolver: (prefix: string, expression: string) => any;
    get default() {
        return this.definition.intellisense as IntelliSense;
    }

    get version() {
        return this.definition.version || this.definition.intellisense?.version;
    }

    get name() {
        return `${this.definition.name}/${this.version}/${this.default.architecture}/${this.default.hostArchitecture || process.arch}`;
    }

    serialize() {
        return {
            name: this.name,
            compilerPath: this.compilerPath,
            definition: this.definition,
            queries: this.cachedQueries.entries(),
            analysis: this.cachedAnalysis.entries()
        };
    }

    static deserialize(obj: Record<string, any>) {
        try {
            const { compilerPath, definition, queries, analysis } = obj;
            const result = new Toolset(compilerPath, definition);
            result.cachedQueries = new Cache(queries);
            result.cachedAnalysis = new Cache(analysis);
            return result;
        } catch {
            return undefined;
        }
    }

    constructor(readonly compilerPath: string, readonly definition: DefinitionFile) {
        this.resolver = createResolver(definition, compilerPath);
        this.definition.intellisense = this.definition.intellisense || {};
        this.cmd = new Command(this.compilerPath, { env: { PATH: `${dirname(this.compilerPath)}${delimiter}${process.env.PATH}` } });

        this.rxResolver = async (prefix: string, expression: string) => {
            if (!prefix) {
                switch (expression.toLowerCase()) {
                    case '-/':
                    case '/-':
                        return '[\\-\\/]';

                    case 'key':
                        return '(?<key>[^=]+)';

                    case 'value':
                        return '(?<value>.+)';

                    case 'keyequalsvalue':
                        return '(?<key>[^=]+)=(?<value>.+)';
                }
            }

            return this.resolver(prefix, expression);
        };
    }

    async applyToConfiguration(intellisenseConfiguration: IntelliSenseConfiguration | IntelliSense, partial: DeepPartial<IntelliSenseConfiguration>, data: Record<string, any> = intellisenseConfiguration) {
        mergeObjects(intellisenseConfiguration, await recursiveRender(formatIntelliSenseBlock(partial), data, this.resolver));
    }

    async query(command: string, queries: Record<string, DeepPartial<IntelliSenseConfiguration>>, intellisenseConfiguration: IntelliSenseConfiguration) {
        // check if we've handled this command before.
        const key = await render(command, {}, this.resolver);
        let text = this.cachedQueries.get(key);

        if (!text) {
            // prepare the command to run
            const cmd = await this.cmd;
            const tmpFiles = new Array<string>();
            let stdout = '';
            let stderr = '';

            const commandLine = await render(command, {}, async (prefix, expression) => {
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
            text = [...out.stdio.all(), ...out.error.all()].join('\n');

            if (stdout) {
                text += await readFile(stdout, 'utf8');
            }
            if (stderr) {
                text += await readFile(stderr, 'utf8');
            }

            // remove the temp files
            tmpFiles.forEach(each => unlinkSync(each));

            this.cachedQueries.set(key, text);
            void updateDiscoveredToolsets();
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

                        await this.applyToConfiguration(intellisenseConfiguration, isense, data);
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

    async processComamndLineArgs(block: Record<string, any>, commandLineArgs: string[], intellisenseConfiguration: IntelliSenseConfiguration, flags: Map<string, any>) {
        // get all the regular expressions and the results to apply
        let allEngineeredRegexes: [RegExp[], any][] = [];
        for (const [engineeredRx, result] of Object.entries(block)) {
            const rxes: RegExp[] = [];
            for (const rx of engineeredRx.split(';')) {
                rxes.push(new RegExp(await render(`^${rx}$`, {}, this.rxResolver)));

            }
            allEngineeredRegexes.push([rxes, result]);
        }
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
                await this.applyToConfiguration(intellisenseConfiguration, isense, capturedData);

                // remove the args used from the command line
                const usedArgs = commandLineArgs.splice(0, engineeredRegexSet.length);

                // but if the no_consume flag set, we should keep the args in the KeptArgs list
                if (flags.get('no_consume')) {
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
                        obj[key] = await filepath.exists(render(value as string, {}, this.resolver)) || value;
                        continue;
                    }

                    // concatenated path (with delimiters)
                    value = values;
                }

                // if it's an array, let's check each value now.
                if (is.array(value)) {
                    obj[key] = [...new Set(await Promise.all(value.map(each => each && filepath.exists(render(each as string, {}, this.resolver)))))].filter(each => each);
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
    async getIntellisenseConfiguration(compilerArgs: string[], options?: { baseDirectory?: string; sourceFile?: string; language?: Language; standard?: CppStandard | CStandard; userIntellisenseConfiguration?: IntelliSenseConfiguration }): Promise<FullIntellisenseConfiguration> {
        const cacheKey = compilerArgs.join(' ');
        let intellisenseConfiguration = this.cachedAnalysis.get(cacheKey);
        if (intellisenseConfiguration) {
            // after getting the cached results, merge in user settings (which are not cached here)
            if (options?.userIntellisenseConfiguration) {
                await this.applyToConfiguration(intellisenseConfiguration, options.userIntellisenseConfiguration);

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
        } as FullIntellisenseConfiguration;

        // Analysis phase
        if (this.definition.analysis) {
            const entries = getActions<Record<string, IntelliSenseConfiguration>>(this.definition.analysis as any, [
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
                        compilerArgs = await this.processComamndLineArgs(block, compilerArgs, intellisenseConfiguration, flags);
                        break;

                    case 'quer':
                        for (const [command, queries] of Object.entries(block as Record<string, Record<string, DeepPartial<IntelliSenseConfiguration>>>)) {
                            await this.query(command, queries, intellisenseConfiguration);
                        }
                        break;

                    case 'expression':
                        for (const [expr, isense] of Object.entries(block as Record<string, DeepPartial<IntelliSenseConfiguration>>)) {
                            if (await evaluateExpression(expr, intellisenseConfiguration, this.resolver)) {
                                await this.applyToConfiguration(intellisenseConfiguration, isense);
                            }
                        }
                        break;
                    default:
                        break;
                }
            }
        }
        // before we go, let's make sure that any *paths are unique, and that they are all absolute
        await this.ensurePathsAreLegit(intellisenseConfiguration);

        // render any variables that are left (if therer are value that are specified explicity in definition that reference variables, this is when they get resolved)
        intellisenseConfiguration = await recursiveRender(intellisenseConfiguration, intellisenseConfiguration, this.resolver);

        // cache the results
        this.cachedAnalysis.set(cacheKey, intellisenseConfiguration);
        void updateDiscoveredToolsets();

        intellisenseConfiguration = structuredClone(intellisenseConfiguration);

        // after the cached results, merge in user settings (since the user can change those at any time)
        if (options?.userIntellisenseConfiguration) {
            await this.applyToConfiguration(intellisenseConfiguration, options.userIntellisenseConfiguration);

            // before we go, let's make sure that any *paths are unique, and that they are all absolute
            await this.ensurePathsAreLegit(intellisenseConfiguration);
        }

        this.postProcessIntellisense(intellisenseConfiguration);

        return intellisenseConfiguration;
    }

    /** the final steps to producing the parser args for EDG */
    postProcessIntellisense(intellisense: IntelliSense) {
        const args = [];
        // turn the macros into -D flags
        if (intellisense.macros) {
            for (const [name, value] of Object.entries(intellisense.macros)) {
                args.push(`-D${name}=${value}`);
            }
        }

        // generate the two sets of include paths that EDG supports:
        // --inlcude_directory and --sys_include
        for (const each of intellisense.include?.builtInPaths ?? []) {
            // alt : args.push('--sys_include', each);
            args.push(`-I${each}`);
        }

        for (const each of intellisense.include?.systemPaths ?? []) {
            args.push('--sys_include', each);
        }
        for (const each of intellisense.include?.externalPaths ?? []) {
            args.push('--sys_include', each);
        }

        for (const each of intellisense.include?.paths ?? []) {
            args.push('--include_directory', each);
        }
        for (const each of intellisense.include?.environmentPaths ?? []) {
            args.push('--include_directory', each);
        }
        if (is.array(intellisense.parserArguments)) {
            intellisense.parserArguments.push(...args);
        }
    }
}
