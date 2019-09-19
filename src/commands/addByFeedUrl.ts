import { window, ProgressOptions, ProgressLocation, commands } from "vscode";
import { COMMANDS } from "../constants";
import { Command } from "./command";
import { Storage } from "../storage";

export class AddByFeedUrlCommand implements Command {
    COMMAND = COMMANDS.ADD_BY_FEED_URL

    constructor(private storage: Storage, private log: (msg: string | true) => void) {
    }

    async run() {
        const feedUrl = await window.showInputBox({
            placeHolder: 'http://...',
            prompt: 'Enter a podcast RSS feed URL'
        })
        if (!feedUrl) {
            return
        }
        const progressOpts: ProgressOptions = {
            cancellable: false,
            location: ProgressLocation.Notification,
            title: 'Loading podcast feed...'
        }
        await window.withProgress(progressOpts, async (progress, token) => {
            try {
                await this.storage.fetchPodcast(feedUrl)
            } catch (e) {
                this.log(`Feed ${feedUrl} could not be loaded, see error above`)
                window.showErrorMessage(`Feed failed to load, see log for details.`)
                this.log(true)
                return
            }
            this.storage.starPodcast(feedUrl, true)
            this.storage.saveMetadata()
            commands.executeCommand(COMMANDS.SHOW_STARRED_PODCASTS)
        })
    }
}