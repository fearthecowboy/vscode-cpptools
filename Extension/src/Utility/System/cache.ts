/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { is } from './guards';

export class Cache<T = any> {
    private map = new Map<string, [number, T]>();
    private defaultTimeout = 0;

    constructor(defaultTimeout: number);
    constructor(entries?: readonly (readonly [string, T])[], defaultTimeout?: number);
    constructor(a1: number | readonly (readonly [string, T])[] = [], a2?: number) {
        if (a1 !== undefined) {
            if (is.numeric(a1)) {
                this.defaultTimeout = a1 ?? 0;
            }
            else {
                this.defaultTimeout = a2 ?? 0;
                for (const [key, value] of a1) {
                    this.set(key, value);
                }
            }
        }
    }

    get(key: string): T | undefined {
        const [timeout, value] = this.map.get(key) ?? [];
        if (timeout && timeout < Date.now()) {
            this.map.delete(key);
            return undefined;
        }
        return value;
    }

    getOrAdd(key: string, action: () => T | undefined): T | undefined;
    getOrAdd(key: string, action: () => Promise<T | undefined>): Promise<T | undefined>;
    getOrAdd(key: string, action: () => T | undefined | Promise<T | undefined>): T | undefined | Promise<T | undefined>{
        const result = this.get(key);
        if (result !== undefined) {
            return result;
        }
        const v = action();
        if (is.promise(v)) {
            return v.then(v => this.set(key, v));
        }
        return this.set(key, v);
    }

    set(key: string, value: T | undefined, timeout?: number): T | undefined{
        timeout = timeout ?? this.defaultTimeout;
        if (timeout > 0) {
            timeout = Date.now() + timeout;
        }

        if (value === undefined) {
            // auto delete undefined values
            this.map.delete(key);
            return undefined;
        }
        this.map.set(key, [timeout, value]);
        return value;
    }

    clean() {
        const now = Date.now();
        for (const [key, [timeout]] of this.map) {
            if (timeout && timeout < now) {
                this.map.delete(key);
            }
        }
    }

    entries() {
        const now = Date.now();
        return [...this.map.entries()].filter(([,[timeout]]) => !timeout || timeout > now).map(([key, [, value]]) => [key, value] as const);
    }
}
