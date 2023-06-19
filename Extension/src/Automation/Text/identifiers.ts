/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { is } from '../System/guards';

export function deconstruct(identifier: string | string[]): string[] {
    if (is.array(identifier)) {
        return identifier.flatMap(deconstruct);
    }
    return `${identifier}`
        .replace(/([a-z]+)([A-Z])/g, '$1 $2')
        .replace(/(\d+)([a-z|A-Z]+)/g, '$1 $2')
        .replace(/\b([A-Z]+)([A-Z])([a-z])/, '$1 $2$3')
        .split(/[\W|_]+/)
        .map((each) => each.toLowerCase());
}

export function smash(identifier: string | string[]): string {
    return deconstruct(identifier).join('');
}

export function pascalCase(identifier: string | string[]): string {
    return deconstruct(identifier)
        .map((each) => each.charAt(0).toUpperCase() + each.slice(1))
        .join('');
}

export function camelCase(identifier: string | string[]): string {
    return deconstruct(identifier)
        .map((each, index) => (index === 0 ? each : each.charAt(0).toUpperCase() + each.slice(1)))
        .join('');
}

export function dashCase(identifier: string | string[]): string {
    return deconstruct(identifier).join('-');
}
