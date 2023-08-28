/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

const startTime = Date.now();

export function elapsed() {
    return `[${Date.now() - startTime}msec] `;
}

