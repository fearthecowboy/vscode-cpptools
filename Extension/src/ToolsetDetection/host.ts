/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { resolve } from 'path';
import { SHARE_ENV, Worker, isMainThread } from 'worker_threads';
import { startRemoting } from '../Utility/System/snare';
import { getOutputChannel } from '../logger';

// this code must only run in the main thread.
if (!isMainThread) {
    throw new Error("NOT IN MAIN THREAD");
}

// starts the worker thread and returns the RemoteConnection object
export const remote = startRemoting(new Worker(resolve(__dirname.substring(0, __dirname.lastIndexOf('dist')), "dist", "src", "ToolsetDetection", "Service", 'worker.js'), {stderr:true, stdout: true, env: SHARE_ENV}), {
    // this is the functions we expose to the worker
    "console.log": (text: string) => {
        getOutputChannel().appendLine(text);
    }
});

