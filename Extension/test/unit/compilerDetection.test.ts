/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

/* eslint-disable @typescript-eslint/no-misused-promises */

import { ok } from 'assert';
import { existsSync } from 'fs';
import { describe, it } from 'mocha';
import { homedir } from 'os';
import { delimiter, resolve } from 'path';
import { getToolsets, identifyToolset, initialize } from '../../src/ToolsetDetection/detectToolset';
import { verbose } from '../../src/Utility/Text/streams';
import { isWindows } from '../../src/constants';
import { when } from '../common/internal';

const root = resolve(__dirname, '..', '..', '..', 'bin', 'definitions');
const rgFromVSC = `${homedir()}/AppData/Local/Programs/Microsoft VS Code/resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg.exe`;

const localRipgrep = existsSync (rgFromVSC) ? rgFromVSC : resolve((process.env["PATH"] ?? '').split(delimiter).find(each => existsSync(resolve(each, isWindows ? 'rg.exe' :  'rg'))) || '', isWindows ? 'rg.exe' : 'rg');

describe('Detect Compilers', async () => {
    it('can find some compilers', async () => {
        const started = Date.now();
        await initialize([root], localRipgrep, false); // quick init - we'll call getToolsets next
        console.debug(`Initialized in ${Date.now() - started}ms`);

        const sets = await getToolsets();
        console.debug(`Completed detection of ${sets.size} in ${Date.now() - started}ms`);

        for (const [id, toolset] of sets) {
            console.debug(`Detected Compiler [${id}], ${toolset.definition.name}/${toolset.default.version}/TARGET:${toolset.default.architecture}/HOST:${toolset.default.host}/BITS:${toolset.default.bits}/${toolset.compilerPath}`);
        }

        // make sure it doesn't take long if we ask again.
        {
            const now = Date.now();
            const sets = await getToolsets();
            const elapsed = Date.now() - now;
            console.debug(`Second detection of ${sets.size} in ${elapsed}ms`);
            ok(elapsed < 100, "should be fast for second detection");
        }
    });

    when(isWindows && existsSync('C:\\Program Files\\IAR Systems\\Embedded Workbench 9.3\\arm\\bin\\iccarm.exe')).it('Get Toolset for IAR', async () => {
        const started = Date.now();

        await initialize([root], localRipgrep, false);
        console.debug(`Initialized in ${Date.now() - started}ms`);

        const toolset = await identifyToolset('C:\\Program Files\\IAR Systems\\Embedded Workbench 9.3\\arm\\bin\\iccarm.exe');
        console.debug(`Identify ran in ${Date.now() - started}ms`);

        if (toolset) {
            console.debug(`Detected Compiler ${toolset.definition.name}/${toolset.default.version}/TARGET:${toolset.default.architecture}/HOST:${toolset.default.host}/BITS:${toolset.default.bits}/${toolset.compilerPath}`);
            const isense = await toolset.getIntellisenseConfiguration([]);
            console.debug(`Generated intellisense config in ${Date.now() - started}ms`);
            verbose(JSON.stringify(isense, null, 2));
        }
    });

    when(isWindows && existsSync(`${homedir()}\\AppData\\Local\\Arduino15\\packages\\arduino\\tools\\avr-gcc\\7.3.0-atmel3.6.1-arduino7\\bin\\avr-g++.exe`)).it('Get Toolset for GCC', async () => {
        const started = Date.now();

        await initialize([root], localRipgrep, false);
        console.debug(`Initialized in ${Date.now() - started}ms`);

        const toolset = await identifyToolset(`${homedir()}\\AppData\\Local\\Arduino15\\packages\\arduino\\tools\\avr-gcc\\7.3.0-atmel3.6.1-arduino7\\bin\\avr-g++.exe`);
        console.debug(`Identify ran in ${Date.now() - started}ms`);

        if (toolset) {
            console.debug(`Detected Compiler ${toolset.definition.name}/${toolset.default.version}/TARGET:${toolset.default.architecture}/HOST:${toolset.default.host}/BITS:${toolset.default.bits}/${toolset.compilerPath}`);
            const isense = await toolset.getIntellisenseConfiguration([]);
            console.debug(`Generated intellisense config in ${Date.now() - started}ms`);
            verbose(JSON.stringify(isense, null, 2));
        }
    });

    when(isWindows && existsSync('C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.36.32532\\bin\\Hostx86\\x64\\cl.exe')).it('Get Toolset for MSVC', async () => {
        const started = Date.now();

        await initialize([root], localRipgrep, false);
        console.debug(`Initialized in ${Date.now() - started}ms`);

        const toolset = await identifyToolset('C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.36.32532\\bin\\Hostx86\\x64\\cl.exe');
        console.debug(`Identify ran in ${Date.now() - started}ms`);

        if (toolset) {
            console.debug(`Detected Compiler ${toolset.definition.name}/${toolset.default.version}/TARGET:${toolset.default.architecture}/HOST:${toolset.default.host}/BITS:${toolset.default.bits}/${toolset.compilerPath}`);
            const isense = await toolset.getIntellisenseConfiguration([]);
            console.debug(`Generated intellisense config in ${Date.now() - started}ms`);
            verbose(JSON.stringify(isense, null, 2));
        }
    });

});
