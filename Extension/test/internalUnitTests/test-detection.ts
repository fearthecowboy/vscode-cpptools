/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { ok } from 'assert';
import { describe, it } from 'mocha';
import { resolve } from 'path';
import { getToolsets, identifyToolset, initialize } from '../../src/ToolsetDetection/compiler-detection';

//eval printf \"%s\\n\" \"~/.foo & bar\" this is a test $PATH
//https://github.com/migueldeicaza/mono-wasm-libc/blob/96eaa7afc23cd675358595e1dd6ab4b6c8f9f07f/src/misc/wordexp.c#L32

const root = resolve(__dirname,'..','..','..','bin','definitions');
const localRipgrep = 'C:/Users/garre/AppData/Local/Programs/Microsoft VS Code/resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg.exe';

describe('Detect Compilers', () => {
    it('can find some compilers',async ()=> {
        const started = Date.now();
        await initialize([root],localRipgrep);
        console.debug(`Initialized in ${Date.now() - started}ms`);

        const sets = await getToolsets();
        console.debug(`Completed detection of ${sets.size} in ${Date.now() - started}ms`);

        for(const [id, toolset] of sets) {
            console.debug(`Detected Compiler [${id}], ${toolset.definition.name}/${toolset.default.version}/TARGET:${toolset.default.architecture}/HOST:${toolset.default.host}/BITS:${toolset.default.bits}/${toolset.compilerPath}`);
        }

        // make sure it doesn't take long if we ask again.
        {
            const now = Date.now();
            const sets = await getToolsets();
            const elapsed = Date.now() - now;
            console.debug(`Second detection of ${sets.size} in ${elapsed}ms`);
            ok(elapsed < 50 , "should be fast for second detection");
        }
    });

    it('Get Toolset for IAR',async ()=> {
        const started = Date.now();

        await initialize([root],localRipgrep,false);
        console.debug(`Initialized in ${Date.now() - started}ms`);

        const toolset = await identifyToolset('C:\\Program Files\\IAR Systems\\Embedded Workbench 9.3\\arm\\bin\\iccarm.exe');
        console.debug(`Identify ran in ${Date.now() - started}ms`);

        if (toolset) {
            console.debug(`Detected Compiler ${toolset.definition.name}/${toolset.default.version}/TARGET:${toolset.default.architecture}/HOST:${toolset.default.host}/BITS:${toolset.default.bits}/${toolset.compilerPath}`);
            const isense = await toolset.getIntellisenseConfiguration([]);
            console.debug(`Generated intellisense config in ${Date.now() - started}ms`);
            console.log(JSON.stringify(isense,null,2));
        }
    });

    it('Get Toolset for GCC',async ()=> {
        const started = Date.now();

        await initialize([root],localRipgrep,false);
        console.debug(`Initialized in ${Date.now() - started}ms`);

        const toolset = await identifyToolset('C:\\Users\\garre\\AppData\\Local\\Arduino15\\packages\\arduino\\tools\\avr-gcc\\7.3.0-atmel3.6.1-arduino7\\bin\\avr-g++.exe');
        console.debug(`Identify ran in ${Date.now() - started}ms`);

        if (toolset) {
            console.debug(`Detected Compiler ${toolset.definition.name}/${toolset.default.version}/TARGET:${toolset.default.architecture}/HOST:${toolset.default.host}/BITS:${toolset.default.bits}/${toolset.compilerPath}`);
            const isense = await toolset.getIntellisenseConfiguration([]);
            console.debug(`Generated intellisense config in ${Date.now() - started}ms`);
            console.log(JSON.stringify(isense,null,2));
        }
    });

    it('Get Toolset for MSVC',async ()=> {
        const started = Date.now();

        await initialize([root],localRipgrep,false);
        console.debug(`Initialized in ${Date.now() - started}ms`);

        const toolset = await identifyToolset('C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.35.32215\\bin\\Hostx86\\x64\\cl.exe');
        console.debug(`Identify ran in ${Date.now() - started}ms`);

        if (toolset) {
            console.debug(`Detected Compiler ${toolset.definition.name}/${toolset.default.version}/TARGET:${toolset.default.architecture}/HOST:${toolset.default.host}/BITS:${toolset.default.bits}/${toolset.compilerPath}`);
            const isense = await toolset.getIntellisenseConfiguration([]);
            console.debug(`Generated intellisense config in ${Date.now() - started}ms`);
            console.log(JSON.stringify(isense,null,2));
        }
    });

});
