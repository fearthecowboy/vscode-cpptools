/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { Context, createContext, runInContext, Script } from 'vm';
import { stringify } from '../System/json';
import { verbose } from '../Text/streams';
import { CreateOptions, ScriptError } from './interfaces';

/**
 * Creates a reusable safe-eval sandbox to execute code in.
 */
export function createSandbox(): <T>(code: string, context?: any) => T {
    const sandbox = createContext({});
    return (code: string, context?: any) => {
        const response = `SAFE_EVAL_${Math.floor(Math.random() * 1000000)}`;
        sandbox[response] = {};
        if (context) {
            Object.keys(context).forEach((key) => (sandbox[key] = context[key]));
            runInContext(
                `try {  ${response} = ${code} } catch (e) { ${response} = undefined }`,
                sandbox
            );
            for (const key of Object.keys(context)) {
                delete sandbox[key];
            }
        } else {
            try {
                runInContext(`${response} = ${code}`, sandbox);
            } catch (e) {
                sandbox[response] = undefined;
            }
        }
        return sandbox[response];
    };
}

export const safeEval = createSandbox();

/**
 * A class that provides the ability to execute code from the user in a safe way.
 * (it does so using node's VM support.)
 */
export class Sandbox {
    context: Context;

    constructor(initializeContext: Record<string, any> = {}) {
        this.context = createContext({
            exports: {},
            ...initializeContext,
            console: {
                log: console.log,
                error: console.error,
                debug: console.debug,
                info: console.info,
                warn: console.warn,
                verbose: verbose
            },
            JSON: {
                stringify: (obj: any) => stringify(obj),
                parse: (str: string) => JSON.parse(str)
            }

        });
    }

    protected require(module: string) {
        return require(module);
    }

    /**
     * Creates an adhoc function from raw JS code.
     *
     * This wraps raw javascript code into a function with some interesting caveats:
     *  - It has to do some magic to get 'return' statements to work correctly
     *  - it suppresses some errors from the TS compiler about the use of 'await' at the top-level and module imports.
     *    (no worries, this is expected)
     *
     * @param sourceCode the code to turn into a function
     * @param parameterNames the names of the parameters to generate for the function
     * @param options Function Creation Options
     * @return an array of errors if there were any
     * @returns a function that can be called with the given parameters
     */
    createFunction<T = ((...args: any[]) => unknown)>(sourceCode: string, parameterNames: string[], options?: CreateOptions & { async?: false; transpile?: false }): ScriptError[] | T;
    createFunction<T = ((...args: any[]) => Promise<unknown>)>(sourceCode: string, parameterNames: string[], options: CreateOptions & { async: true; transpile?: false | undefined }): ScriptError[] | T;

    createFunction<T = ((...args: any[]) => unknown)>(sourceCode: string, parameterNames: string[], options?: CreateOptions & { async?: false; transpile: true }): Promise<ScriptError[] | T>;
    createFunction<T = ((...args: any[]) => Promise<unknown>)>(sourceCode: string, parameterNames: string[], options: CreateOptions & { async: true; transpile: true }): Promise<ScriptError[] | T>;
    createFunction<T = ((...args: any[]) => unknown)>(sourceCode: string, parameterNames: string[] = [], options?: CreateOptions & { async?: boolean }): ScriptError[] | T | Promise<ScriptError[] | T> {
        // insert defaults in options
        options = {
            lineOffset: 0,
            columnOffset: 0,
            filename: '<sandbox>',
            transpile: false,
            ...options ? options : {}
        };

        let scriptSrc = sourceCode;

        // if we don't have to invoke the transpiler, this is simple, and a lot cheaper.
        // (but we don't get any fancy errors if it's not valid javascript, so, this should be used when it's not unverified user input)
        scriptSrc = `${options.async ? 'async ' : ''}(${parameterNames.join(',')}) => { ${scriptSrc} }`;

        // create the script object, run it, and capture the generated function
        return new Script(scriptSrc, options).runInContext(this.context, {});
    }
}

