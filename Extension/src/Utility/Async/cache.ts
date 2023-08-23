/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { elapsed } from '../System/performance';

const cacheMap = new Map<string, Promise<any>>();
export async function qcache<T>(ctx: string, action: () => Promise<T>): Promise<T> {
    console.log(`${elapsed()}  In Cache? ${ctx} ${cacheMap.has(ctx)}`);
    let result = cacheMap.get(ctx) as Promise<T>;
    if (result === undefined) {
        cacheMap.set(ctx, result = action());
    }
    return result;
}
