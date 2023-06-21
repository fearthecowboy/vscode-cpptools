/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { inspect } from 'util';
import { is } from '../System/guards';
import { notify } from './dispatcher';
import { channels } from './names';

export function out(...messages: any[]) {
    messages.forEach((each) => console.log(each));
}

export function debug(..._messages: any[]) {
    // messages.forEach((message) => notify(channels.debug, is.primitive(message) ? message.toString() : inspect(message, false, 2, true)));
}

export function clear() {
    notify('clear');
}

export function verbose(...messages: any[]) {
    messages.forEach((message) => notify(channels.verbose, is.primitive(message) ? message.toString() : inspect(message, false, 2, true)));
}

export function info(...messages: any[]) {
    messages.forEach((message) => notify(channels.info, is.primitive(message) ? message.toString() : inspect(message, false, 2, true)));
}

export function warning(...messages: any[]) {
    messages.forEach((message) => notify(channels.warning, is.primitive(message) ? message.toString() : inspect(message, false, 2, true)));
}

export function internal(...messages: any[]) {
    if ((global as any).DEVMODE) {
        messages.forEach((message) => notify(channels.internal, is.primitive(message) ? message.toString() : inspect(message, false, 2, true)));
    }
}

export function error(...messages: any[]) {
    messages.forEach(message => notify(channels.error, is.primitive(message) ? message.toString() : inspect(message, false, 2, true)));
}

