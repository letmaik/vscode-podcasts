import { window, QuickPickItem, QuickInputButton, Uri, commands, QuickInputButtons } from "vscode";
import { COMMANDS } from "../constants";
import { Command } from "./command";
import { Storage } from "../storage";
import { Resources } from "../resources";

interface PodcastItem extends QuickPickItem {
    url: string
}

export class ShowStarredPodcastsCommand implements Command {
    COMMAND = COMMANDS.SHOW_STARRED_PODCASTS

    constructor(private storage: Storage, private resources: Resources,
                private log: (msg: string) => void) {
    }

    async run() {
        const feedUrls = this.storage.getStarredPodcastUrls()
        // TODO show progress
        // TODO handle errors
        await Promise.all(feedUrls.map(feedUrl => this.storage.fetchPodcast(feedUrl)))
        const feedItems: PodcastItem[] = feedUrls.map(feedUrl => {
            const podcast = this.storage.getPodcast(feedUrl)
            let detail = ''
            const downloaded = Object.keys(podcast.local!.downloaded).length
            if (downloaded > 0) {
                detail = `$(database) ${downloaded}`
            }
            return {
                label: podcast.local!.title,
                detail: detail,
                url: feedUrl
            }
        })

        feedItems.sort((a,b) => a.label.localeCompare(b.label))

        const addByFeedUrlButton: QuickInputButton = {
            iconPath: this.resources.getIconPath('add'),
            tooltip: 'Add via feed URL'
        }

        const importFromOPMLButton: QuickInputButton = {
            iconPath: this.resources.getIconPath('folder-opened'),
            tooltip: 'Import from OPML'
        }

        const exportAsOPMLButton: QuickInputButton = {
            iconPath: this.resources.getIconPath('save'),
            tooltip: 'Export as OPML'
        }

        const feedPicker = window.createQuickPick<PodcastItem>()
        feedPicker.ignoreFocusOut = true
        feedPicker.matchOnDescription = true
        feedPicker.title = 'Starred podcasts'
        feedPicker.placeholder = 'Pick a podcast'
        feedPicker.items = feedItems
        feedPicker.buttons = [QuickInputButtons.Back, addByFeedUrlButton, importFromOPMLButton, exportAsOPMLButton]
        
        feedPicker.onDidTriggerButton(async btn => {
            if (btn == QuickInputButtons.Back) {
                commands.executeCommand(COMMANDS.SHOW_MAIN_COMMANDS)
            } else if (btn == addByFeedUrlButton) {
                commands.executeCommand(COMMANDS.ADD_BY_FEED_URL)
            } else if (btn == importFromOPMLButton) {
                commands.executeCommand(COMMANDS.IMPORT_FROM_OPML)
            } else if (btn == exportAsOPMLButton) {
                commands.executeCommand(COMMANDS.EXPORT_AS_OPML)
            }
            feedPicker.dispose()
        })

        const episodePickerPromise = new Promise<PodcastItem | undefined>((resolve, _) => {
            feedPicker.onDidAccept(() => {
                resolve(feedPicker.selectedItems[0])
                feedPicker.dispose()
            })
            feedPicker.onDidHide(() => {
                resolve(undefined)
                feedPicker.dispose()
            })
        })
        
        feedPicker.show()

        const feedPick = await episodePickerPromise
        if (!feedPick) {
            return
        }
        const feedUrl = feedPick.url
        const resolveListenNotes = false
        commands.executeCommand(COMMANDS.SHOW_PODCAST, feedUrl, resolveListenNotes, this.COMMAND)
    }
}