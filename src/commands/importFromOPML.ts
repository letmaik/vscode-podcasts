import { window, ProgressOptions, ProgressLocation } from "vscode";
import { COMMANDS } from "../constants";
import { Command } from "./command";
import { Storage } from "../storage";
import { readFile } from "../util";
import * as parseOPML from 'node-opml-parser'

export class ImportFromOPMLCommand implements Command {
    COMMAND = COMMANDS.IMPORT_FROM_OPML

    constructor(private storage: Storage, private log: (msg: string | true) => void) {
    }

    async run() {
        const uris = await window.showOpenDialog({
            openLabel: 'Import from OPML',
            filters: { 'OPML': ['opml'] }
        })
        if (!uris || uris.length === 0) {
            return
        }
        const path = uris[0].fsPath
        const str = await readFile(path, 'utf-8')
        let items: any[]
        try {
            items = await new Promise<any[]>((resolve, reject) => {
                parseOPML(str, (err, items) => {
                    if (err) {
                        reject(err)
                    } else {
                        resolve(items)
                    }
                })
            })
        } catch (e) {
            this.log(`Error reading OPML file ${path}: ${e}`)
            window.showErrorMessage('Error reading OPML file')
            return
        }
        const progressOpts: ProgressOptions = {
            cancellable: false,
            location: ProgressLocation.Notification,
            title: 'Importing podcasts...'
        }
        let failed = false 
        await window.withProgress(progressOpts, async (progress, token) => {
            for (const item of items) {
                progress.report({
                    increment: 1 / items.length * 100
                })
                const feedUrl = item.feedUrl as string
                try {
                    await this.storage.fetchPodcast(feedUrl)
                } catch (e) {
                    this.log(`Feed ${feedUrl} (${item.title}) could not be loaded, see error above`)
                    failed = true
                    continue
                }
                this.storage.starPodcast(feedUrl, true)
            }
        })
        this.storage.saveMetadata()
        if (failed) {
            window.showWarningMessage(`Some podcasts failed to import, see log for details.`)
            this.log(true)
        } else {
            window.showInformationMessage(`All podcasts successfully imported!`)
        }
    }
}