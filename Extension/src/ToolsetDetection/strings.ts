/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { is } from '../Utility/System/guards';
import { OneOrMore } from './interfaces';

export function strings(input: OneOrMore<string> | undefined | Set<string> | (string | undefined)[]): string[] {
    if (!input) {
        return [];
    }
    if (input instanceof Set) {
        return [...input];
    }
    if (is.string(input)) {
        return [input];
    }
    return input as string[];
}

export function getActions<T>(obj: any, actions: [string, string[]][]) {
    if (!obj || typeof obj !== 'object') {
        return [];
    }

    return Object.entries(obj).map(([expression, block], ndx) => {
        const [, act, flag, comment] = /^([a-zA-Z]{4})(?:[a-zA-Z]*)(?:[:])?(.*?)(#.*?)?$/.exec(expression) || [];
        // coerce the action to be one of the valid actions, or empty string.
        const [action, validFlags] = actions.find(each => each[0].startsWith(act.toLowerCase())) || ['', []];

        // extract the flags
        const flags = new Map();
        for (const each of flag.split(',')) {
            // eslint-disable-next-line prefer-const
            let [key, value] = each.split('=', 2);
            if (!key) {
                continue;
            }
            key = key.toLowerCase().trim();

            if (validFlags.includes(key)) {
                flags.set(key, value?.trim() ?? true);
            }
        }
        // get the priority
        const priority = parseInt(flags.get('priority') ?? '0') || ndx;
        return { action, block, flags, priority, comment } as const;
    }).sort((a, b) => a.priority - b.priority).filter(each => each.action) as { action: string; block: T; flags: Map<string, string | boolean>; priority: number; comment?: string }[];
}
