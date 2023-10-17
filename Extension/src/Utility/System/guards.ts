/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { Socket } from 'node:net';
import { isPromise } from 'node:util/types';
import { Emitter } from '../Eventing/emitter';
import { AsyncConstructor, Constructor, Primitive } from './types';

// eslint-disable-next-line @typescript-eslint/naming-convention
export class is {
    /** Returns true if the value is a string, number, or boolean */
    static primitive(node: any): node is Primitive {
        switch (typeof node) {
            case 'boolean':
            case 'number':
            case 'string':
                return true;
        }
        return false;
    }

    static numeric(node: any): node is number {
        return typeof node === 'number' && !isNaN(node) && isFinite(node);
    }

    static object(node: any): node is Record<string, any> {
        return typeof node === 'object' && node !== null && !is.array(node);
    }

    static nullish(value: any): value is null | undefined {
        return value === null || value === undefined;
    }

    static promise(value: any): value is Promise<any> {
        return isPromise(value) || (value && typeof value.then === 'function');
    }

    static iterable<T = unknown>(instance: any): instance is Iterable<T> {
        return !(is.nullish(instance) || is.string(instance)) && !!instance[Symbol.iterator];
    }

    static asyncIterable(instance: any): instance is AsyncIterable<unknown> {
        return !is.nullish(instance) && !!instance[Symbol.asyncIterator];
    }

    static Constructor(instance: any): instance is Constructor {
        return typeof instance === 'function' && !!instance.prototype && !Object.getOwnPropertyNames(instance).includes('arguments') && instance.toString().match(/^function.*\{ \[native code\] \}|^class/g);
    }

    static asyncConstructor(instance: any): instance is AsyncConstructor<any> {
        return typeof instance === 'function' && !!instance.class && is.Constructor(instance.class);
    }

    static array(instance: any): instance is any[] {
        return Array.isArray(instance);
    }

    static set(instance: any): instance is Set<any> {
        return instance instanceof Set;
    }

    static string(instance: any): instance is string {
        return typeof instance === 'string';
    }

    static socket(instance: any): instance is Socket {
        return instance instanceof Socket;
    }

    // eslint-disable-next-line @typescript-eslint/ban-types
    static function(instance: any): instance is Function {
        return typeof instance === 'function';
    }

    static emitter(instance: any): instance is Emitter {
        return typeof instance?.isKnownEvent === 'function';
    }
    static cancelled(instance: any): instance is 'Cancelled' {
        return instance === 'Cancelled';
    }
    static continue(instance: any): instance is undefined {
        return instance === undefined;
    }
    static error(instance: any): instance is Error {
        return instance instanceof Error;
    }
    static empty(instance: any): boolean {
        // if the thing is undefined or an empty array
        if (instance === undefined || (is.array(instance) && instance.length === 0)) {
            return true;
        }

        // if it's an object, check if it's empty
        if (is.object(instance)) {
            // objects can be 'empty' if all the children are empty
            return !!Object.entries(instance).find(([,value]) => !is.empty(value));
        }

        return false;
    }
}
