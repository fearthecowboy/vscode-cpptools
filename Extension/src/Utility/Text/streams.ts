/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { isVerbose } from '../../constants';

export function verbose(...args: any[]): void {
    return isVerbose ? console.log(... args) : undefined;
}
