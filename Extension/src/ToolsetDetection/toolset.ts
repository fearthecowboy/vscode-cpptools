/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { Configuration } from '../LanguageServer/configurations';
import { MarshalByReference } from '../Utility/System/snare';
import { appendUniquePath } from './Service/strings';
import { remote } from './host';
import { CStandard, CppStandard, FullIntellisenseConfiguration, IntelliSenseConfiguration, Language } from './interfaces';

/**
 * This is a byref proxy to the toolset.
 *
 * As with all byref proxies, it is a reference to an object that lives in the worker thread.
 * It is important to call .dispose() when you are done with it, as this enables the worker
 * thread to release the object and free up resources.
 *
 */
export class Toolset extends MarshalByReference {
    async getIntellisenseConfiguration(compilerArgs: string[], options?: { baseDirectory?: string; sourceFile?: string; language?: Language; standard?: CppStandard | CStandard; userIntellisenseConfiguration?: IntelliSenseConfiguration }): Promise<FullIntellisenseConfiguration> {
        return this.remote.request('Toolset.getIntellisenseConfiguration', this.instance, compilerArgs, options);
    }
    harvestFromConfiguration(configuration: Configuration, intellisense: FullIntellisenseConfiguration) {
        // includePath
        appendUniquePath(intellisense.include.paths, configuration.includePath);

        // macFrameworkPath
        appendUniquePath(intellisense.include.frameworkPaths, configuration.macFrameworkPath);

        // cStandard
        // cppStandard

        // defines
        for (const define of configuration.defines || []) {
            const [,key, value] = /^([^=]+)=*(.*)?$/.exec(define) ?? [];
            if (key && value) {
                intellisense.defines[key] = value;
            }
        }

        // forcedInclude
        appendUniquePath(intellisense.forcedIncludeFiles, configuration.forcedInclude);

        return intellisense;
    }
}
/**
 * Makes a remote call to the identifyToolset function in the worker thread.
 *
 * @returns a Promise to either a valid toolset or undefined if there was no match..
 */
export function identifyToolset(candidate: string): Promise<Toolset | undefined> {
    return remote.marshall(Toolset, remote.request('identifyToolset', candidate));
}

/** Makes a remote call to initialize the toolset detection system */
export async function initialize(configFolders: string[], options?: { quick?: boolean; storagePath?: string }): Promise<Map<string, string>>{
    return new Map(await remote.request('initialize', configFolders, options));
}

/** Makes a remote call to get the list of toolsets from the worker thread */
export async function getToolsets(): Promise<Map<string, string>>{
    return new Map(await remote.request('getToolsets'));
}
