/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
/* eslint-disable @typescript-eslint/no-unused-vars */

import { $root, glob, updateFiles } from './common';
import { extensionsDir, installExtension, uninstallExtension } from './vscode';

async function getNativeBuildInfo() {
    return {
        "build": "",
        "vs": "",
        "oss": ""

    };
}

export async function update() {

}

export async function copy() {

}

export async function build() {

}

export async function clone() {

}

export async function release() {

}

export async function install(kind: string, version: string) {
    switch (kind) {
        case undefined:
        case 'gallery':
        case 'published':{
            // install it in the isolated vscodearea
            const { id, ver } = await installExtension('ms-vscode.cpptools', version);
            // grab the binaries out
            const files = new Set<string>();
            (await glob(`${extensionsDir}/${id}-${ver}*/bin/cpptools*`)).forEach(each => files.add(each));
            (await glob(`${extensionsDir}/${id}-${ver}*/bin/*.dll`)).forEach(each => files.add(each));
            (await glob(`${extensionsDir}/${id}-${ver}*/bin/*.exe`)).forEach(each => files.add(each));
            console.log(files);

            await updateFiles([...files], `${$root}/bin`);
            // remove the extension fromthe isolated vscode
            await uninstallExtension('ms-vscode.cpptools');
        }

    }
    // await installExtension('ms-vscode.cpptools', version);
    // await uninstallExtension('ms-vscode.cpptools');
    // const {cli, args} = await installVsCode();

    //const result = spawnSync(cli, [...args, '--install-extension', 'ms-vscode.cpptools'], { encoding: 'utf-8', stdio: 'inherit' ,env:environment()});

}

export async function main() {
    // install the binaries from the build folder
    // const info = getNativeBuildInfo();

}
