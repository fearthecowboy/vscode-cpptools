/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { platform } from 'os';

export const isWindows = platform() === 'win32';

// if you want to see the output of verbose logging, set this to true.
export const isVerbose = false;

