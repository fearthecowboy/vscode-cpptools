/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { getOutputChannel } from '../../logger';

const startTime = Date.now();

export function elapsed() {
    return `[${Date.now() - startTime}msec] `;
}

export function consolelog(text: string) {
    getOutputChannel().appendLine(text);
}

