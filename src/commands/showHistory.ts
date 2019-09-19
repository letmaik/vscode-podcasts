import { window, QuickPickItem } from "vscode";
import { COMMANDS } from "../constants";
import { Command } from "./command";
import { Storage } from "../storage";
import { toHumanDuration, toHumanTimeAgo } from "../util";
import { Player } from "../player";

interface ListenedEpisodeItem extends QuickPickItem {
    feedUrl: string
    guid: string
    lastPlayed: number
}

export class ShowHistoryCommand implements Command {
    COMMAND = COMMANDS.SHOW_HISTORY

    constructor(private storage: Storage, private player: Player,
                private log: (msg: string) => void) {
    }

    async run() {
        const items: ListenedEpisodeItem[] = []
        const meta = this.storage.getMetadata()
        
        for (const feedUrl in meta.roaming.podcasts) {
            const podcast = this.storage.getPodcast(feedUrl)
            const podcastRoaming = podcast.roaming!
            if (!podcast.local) {
                // TODO fetch feed on the fly
                continue
            }
            const guids = Object.keys(podcastRoaming.episodes)
            for (const guid of guids) {
                const episode = this.storage.getEpisode(feedUrl, guid)
                const episodeRoaming = episode.roaming!
                if (!episode.local) {
                    // TODO feed may be outdated, update on the fly
                    continue
                }
                const downloaded = this.storage.isEpisodeDownloaded(feedUrl, guid) ? ' | $(database)' : ''
                const completed = episodeRoaming.completed ? '✓ | ' : ''
                const playing = episodeRoaming.lastPosition ? '▶ ' + toHumanDuration(episodeRoaming.lastPosition) + ' | ' : ''
                items.push({
                    label: episode.local.title,
                    description: episode.local.description,
                    detail: completed + playing + toHumanDuration(episode.local.duration, 'Unknown duration') + 
                        (episode.local.published ? ' | ' + toHumanTimeAgo(episode.local.published) : '') + 
                        ' | ' + podcast.local.title + downloaded,
                    feedUrl: feedUrl,
                    guid: guid,
                    lastPlayed: episodeRoaming.lastPlayed || Date.now()
                })
            }
        }

        items.sort((a,b) => b.lastPlayed - a.lastPlayed)

        const pick = await window.showQuickPick(items, {
            ignoreFocusOut: true,
            placeHolder: 'Pick an episode to play',
            matchOnDescription: true,
            matchOnDetail: true
        })
        if (!pick) {
            return
        }
        await this.player.play(pick.feedUrl, pick.guid)
    }
}