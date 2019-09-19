import { window } from "vscode";
import { COMMANDS } from "../constants";
import { Command } from "./command";
import { Storage } from "../storage";
import * as toOPML from 'opml-generator'
import { writeFile } from "../util";

export class ExportAsOPMLCommand implements Command {
    COMMAND = COMMANDS.EXPORT_AS_OPML

    constructor(private storage: Storage, private log: (msg: string) => void) {
    }

    async run() {
        const feedUrls = this.storage.getStarredPodcastUrls()
        // TODO show progress
        // TODO handle errors
        await Promise.all(feedUrls.map(feedUrl => this.storage.fetchPodcast(feedUrl)))
        const uri = await window.showSaveDialog({
            saveLabel: 'Export as OPML',
            filters: { 'OPML': ['opml'] }
        })
        if (!uri) {
            return
        }
        const header = {
            dateCreated: new Date()
        }
        const outlines = feedUrls.map(feedUrl => {
            const podcast = this.storage.getPodcast(feedUrl)
            return {
                text: podcast.local!.title,
                htmlUrl: podcast.local!.homepageUrl,
                xmlUrl: feedUrl
            }
        })
        const opml = toOPML(header, outlines)
        await writeFile(uri.fsPath, opml)
    }
}