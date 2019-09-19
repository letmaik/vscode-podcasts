import { window, QuickPickItem, QuickInputButton, QuickInputButtons, commands, env, Uri } from "vscode";
import { COMMANDS } from "../constants";
import { Command } from "./command";
import { Storage, PodcastMetadata } from "../storage";
import { Player } from "../player";
import { toHumanDuration, toHumanTimeAgo } from "../util";
import { ListenNotes } from "../listenNotes";
import { Resources } from "../resources";

interface EpisodeItem extends QuickPickItem {
    guid: string
    published?: number
}

export class ShowPodcastCommand implements Command {
    COMMAND = COMMANDS.SHOW_PODCAST

    constructor(private storage: Storage, private resources: Resources,
                private player: Player, private listenNotes: ListenNotes,
                private log: (msg: string) => void) {
    }

    async run(feedUrl: string, resolveListenNotes?: boolean, prevCmd?: string, prevCmdArg?: any) {
        const getEpisodeItems = (podcast: PodcastMetadata) => {
            const items: EpisodeItem[] = Object.keys(podcast.local!.episodes).map(guid => {
                const episode = this.storage.getEpisode(feedUrl, guid)
                const episodeLocal = episode.local!
                const downloaded = this.storage.isEpisodeDownloaded(feedUrl, guid) ? ' | $(database)' : ''
                const completed = episode.roaming && episode.roaming.completed ? '✓ | ' : ''
                const playing = episode.roaming && episode.roaming.lastPosition 
                    ? '▶ ' + toHumanDuration(episode.roaming.lastPosition) + ' | ' : ''
                return {
                    label: episodeLocal.title,
                    description: episodeLocal.description,
                    detail: completed + playing + toHumanDuration(episodeLocal.duration, 'Unknown duration') + 
                        (episodeLocal.published ? ' | ' + toHumanTimeAgo(episodeLocal.published) : '') +
                        downloaded,
                    guid: guid,
                    published: episodeLocal.published
                }
            })
            return items
        }

        const episodePicker = window.createQuickPick<EpisodeItem>()
        episodePicker.ignoreFocusOut = true
        episodePicker.title = 'Loading...'
        episodePicker.placeholder = 'Loading...'
        episodePicker.busy = true
        episodePicker.show()

        if (resolveListenNotes) {
            feedUrl = await this.listenNotes.resolveRedirect(feedUrl)
        }

        // TODO make configurable
        const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
        let podcast = await this.storage.fetchPodcast(feedUrl, oneWeekAgo)

        const refreshButton: QuickInputButton = {
            iconPath: this.resources.getIconPath('refresh'),
            tooltip: 'Refresh Feed'
        }

        const websiteButton: QuickInputButton = {
            iconPath: this.resources.getIconPath('globe'),
            tooltip: 'Open Podcast Website'
        }

        const starButton: QuickInputButton = {
            iconPath: this.resources.getIconPath('star-empty'),
            tooltip: 'Add to Starred Podcasts'
        }

        const unstarButton: QuickInputButton = {
            iconPath: this.resources.getIconPath('star'),
            tooltip: 'Remove from Starred Podcasts'
        }

        const items = getEpisodeItems(podcast)
        if (!items.some((item) => item.published === undefined)) {
            items.sort((a,b) => b.published! - a.published!)
        }

        episodePicker.busy = false
        episodePicker.title = podcast.local!.title
        episodePicker.items = items
        episodePicker.placeholder = 'Pick an episode to play'

        const setButtons = () => {
            const buttons: QuickInputButton[] = []
            buttons.push(this.storage.isStarredPodcast(feedUrl) ? unstarButton : starButton)
            buttons.push(websiteButton)
            buttons.push(refreshButton)
            if (prevCmd) {
                buttons.push(QuickInputButtons.Back)
            }
            episodePicker.buttons = buttons
        }
        setButtons()

        episodePicker.onDidTriggerButton(async btn => {
            if (btn == QuickInputButtons.Back) {
                commands.executeCommand(prevCmd!, prevCmdArg)
                episodePicker.dispose()
            } else if (btn == refreshButton) {
                episodePicker.busy = true
                try {
                    await this.storage.updatePodcast(feedUrl!)
                } catch (e) {
                    window.showWarningMessage(`Updating the feed failed: ${e}`)
                    return
                } finally {
                    episodePicker.busy = false
                }
                podcast = this.storage.getPodcast(feedUrl!)
                episodePicker.items = getEpisodeItems(podcast)
            } else if (btn == websiteButton) {
                env.openExternal(Uri.parse(podcast.local!.homepageUrl))
            } else if (btn == starButton) {
                this.storage.starPodcast(feedUrl, true)
                this.storage.saveMetadata({roaming: true})
                setButtons()
            } else if (btn == unstarButton) {
                this.storage.starPodcast(feedUrl, false)
                this.storage.saveMetadata({roaming: true})
                setButtons()
            }
        })
        const episodePickerPromise = new Promise<EpisodeItem | undefined>((resolve, _) => {
            episodePicker.onDidAccept(() => {
                resolve(episodePicker.selectedItems[0])
                episodePicker.dispose()
            })
            episodePicker.onDidHide(() => {
                resolve(undefined)
                episodePicker.dispose()
            })
        })
        const pick = await episodePickerPromise

        if (!pick) {
            return
        }

        await this.player.play(feedUrl, pick.guid)
    }
}