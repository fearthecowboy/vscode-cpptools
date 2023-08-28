/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { fail } from 'assert';
import { parentPort } from 'worker_threads';
import { entries } from '../../Utility/System/map';
import { getByRef, ref, startRemoting, unref } from '../../Utility/System/snare';
import { getToolsets, identifyToolset, initialize } from './detectToolset';
import { Toolset } from './toolset';

/** This is the SNARE remote call interface dispatcher that the worker thread supports  */
const remote = parentPort ? startRemoting(parentPort, {
    initialize: (configFolders: string[], options: any) => entries(initialize(configFolders, options), (key, toolset) => [key, toolset.name]),
    getToolsets: () => entries(getToolsets(), (key, toolset) => [key, toolset.name]),
    identifyToolset: (candidate: string) => ref(identifyToolset(candidate)),
    dispose: (identity: number) => unref(identity),
    "Toolset.getIntellisenseConfiguration": (identity: number, compilerArgs: string[], options: any) => (getByRef<Toolset>(identity).getIntellisenseConfiguration(compilerArgs, options))
}) : fail("No parent port");

export function log(text: string) {
    remote.notify('console.log', text);
}

