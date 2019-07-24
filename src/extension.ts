import { ExtensionContext, workspace, window, Disposable, commands, Uri, QuickPickItem, QuickInputButton } from 'vscode'

import { NAMESPACE } from './constants'
import { ShellPlayer } from './shellPlayer';
import { ListenNotes } from './listenNotes'
import { toHumanDuration, toHumanTimeAgo } from './util';
import { Storage, PodcastMetadata } from './storage';
import { Player } from './player';
import { StatusBar } from './statusBar';
import { Configuration, Feed } from './types';
import { ListenNotesPodcastSearchQuickPick, ListenNotesEpisodeSearchQuickPick } from './quickpicks/listenNotesSearch';

interface CommandItem extends QuickPickItem {
    cmd: string
}

interface EpisodeItem extends QuickPickItem {
    guid: string
    published: number
}

interface PodcastItem extends QuickPickItem {
    url: string
}

interface DownloadedEpisodeItem extends QuickPickItem {
    feedUrl: string
    guid: string
    downloadDate: number
}

function getConfig(): Configuration {
    const rootCfg = workspace.getConfiguration('podcasts')
    const searchCfg = workspace.getConfiguration('podcasts.search')
    return {
        feeds: rootCfg.get<Feed[]>('feeds')!,
        player: rootCfg.get<string>('player'),
        search: {
            genres: searchCfg.get<string[]>('genres')!,
            sortByDate: searchCfg.get<boolean>('sortByDate')!,
            language: searchCfg.get<string>('language')!,
            minimumLength: searchCfg.get<number>('minimumLength')!,
            maximumLength: searchCfg.get<number>('maximumLength')!,
        }
    }
}

export async function activate(context: ExtensionContext) {
    const disposables: Disposable[] = []
    context.subscriptions.push(new Disposable(() => Disposable.from(...disposables).dispose()))

    const outputChannel = window.createOutputChannel('Podcasts')
    disposables.push(outputChannel)

    const log = outputChannel.appendLine

    let cfg = getConfig()

    const shellPlayer = new ShellPlayer({
        playerPath: cfg.player,
        supportDir: context.asAbsolutePath('extra')
    }, log)

    const storage = new Storage(context.globalStoragePath, log)
    await storage.loadMetadata()

    const statusBar = new StatusBar(disposables)
    const player = new Player(shellPlayer, storage, statusBar, log, disposables)
    const listenNotes = new ListenNotes(log)

    // TODO allow to add podcasts from search to the config

    disposables.push(workspace.onDidChangeConfiguration(e => {
        cfg = getConfig()
        if (e.affectsConfiguration(NAMESPACE + '.player')) {
            shellPlayer.setPlayerPath(cfg.player)
        }
    }))

    // TODO add command to restart from beginning

    const registerPlayerCommand = (cmd: string, fn: (player: Player) => void) => {
        disposables.push(commands.registerCommand(NAMESPACE + '.' + cmd, async () => {
            try {
                fn(player)
            } catch (e) {
                console.error(e)
                window.showErrorMessage(e.message)
            }
        }))
    }

    registerPlayerCommand('pause', p => p.pause())
    registerPlayerCommand('stop', p => p.stop())
    registerPlayerCommand('skipBackward', p => p.skipBackward())
    registerPlayerCommand('skipForward', p => p.skipForward())
    registerPlayerCommand('slowdown', p => p.slowdown())
    registerPlayerCommand('speedup', p => p.speedup())

    disposables.push(commands.registerCommand(NAMESPACE + '.main', async () => {
        const items: CommandItem[] = [{
            cmd: 'pause',
            label: 'Pause/Unpause'
        }, {
            cmd: 'stop',
            label: 'Stop'
        }, {
            cmd: 'skipBackward',
            label: 'Skip backward'
        }, {
            cmd: 'skipForward',
            label: 'Skip forward'
        }, {
            cmd: 'slowdown',
            label: 'Slow down'
        }, {
            cmd: 'speedup',
            label: 'Speed up'
        }]
        const pick = await window.showQuickPick(items, {
            placeHolder: 'Choose an action'
        })
        if (!pick) {
            return
        }
        commands.executeCommand(NAMESPACE + '.' + pick.cmd)
    }))

    disposables.push(commands.registerCommand(NAMESPACE + '.showDownloaded', async () => {
        const items: DownloadedEpisodeItem[] = []
        const meta = storage.getMetadata()
        for (const [feedUrl, podcast] of Object.entries(meta.podcasts)) {
            const guids = Object.keys(podcast.downloaded)
            for (const guid of guids) {
                const episode = podcast.episodes[guid]
                const download = podcast.downloaded[guid]
                const completed = download.completed ? '✓ | ' : ''
                const playing = download.lastPosition ? '▶ ' + toHumanDuration(download.lastPosition) + ' | ' : ''
                items.push({
                    label: episode.title,
                    description: episode.description,
                    detail: completed + playing + toHumanDuration(episode.duration, 'Unknown duration') + 
                        ' | ' + toHumanTimeAgo(episode.published) + 
                        ' | ' + podcast.title,
                    feedUrl: feedUrl,
                    guid: guid,
                    downloadDate: download.date
                })
            }
        }

        items.sort((a,b) => b.downloadDate - a.downloadDate)

        const pick = await window.showQuickPick(items, {
            ignoreFocusOut: true,
            placeHolder: 'Pick an episode',
            matchOnDescription: true,
            matchOnDetail: true
        })
        if (!pick) {
            return
        }
        await player.play(pick.feedUrl, pick.guid)
    }))

    disposables.push(commands.registerCommand(NAMESPACE + '.play', async (feedUrl?: string) => {
        if (!feedUrl) {
            const feedItems: PodcastItem[] = cfg.feeds.map(feed => {
                let detail = ''
                if (storage.hasPodcast(feed.url)) {
                    const downloaded = Object.keys(storage.getPodcast(feed.url).downloaded).length
                    if (downloaded > 0) {
                        detail = `$(database) ${downloaded}`
                    }
                }
                return {
                    label: feed.title,
                    detail: detail,
                    url: feed.url
                }
            })

            const feedPick = await window.showQuickPick(feedItems, {
                ignoreFocusOut: true,
                matchOnDescription: true,
                placeHolder: 'Pick a podcast'
            })
            if (!feedPick) {
                return
            }
            feedUrl = feedPick.url
        }

        const getEpisodeItems = (podcast: PodcastMetadata) => {
            const items: EpisodeItem[] = Object.keys(podcast.episodes).map(guid => {
                const episode = podcast.episodes[guid]
                const download = podcast.downloaded[guid]
                const downloaded = download ? ' | $(database)' : ''
                const completed = download && download.completed ?  '✓ | ' : ''
                const playing = download && download.lastPosition ? '▶ ' + toHumanDuration(download.lastPosition) + ' | ' : ''
                return {
                    label: episode.title,
                    description: episode.description,
                    detail: completed + playing + toHumanDuration(episode.duration, 'Unknown duration') + 
                        ' | ' + toHumanTimeAgo(episode.published) + downloaded,
                    guid: guid,
                    published: episode.published
                }
            })
            return items
        }

        let podcast = await storage.fetchPodcast(feedUrl)

        const refreshButton: QuickInputButton = {
            iconPath: {
                dark: Uri.file(context.asAbsolutePath('resources/icons/dark/refresh.svg')),
                light: Uri.file(context.asAbsolutePath('resources/icons/light/refresh.svg'))
            },
            tooltip: 'Refresh'
        }

        const items = getEpisodeItems(podcast)
        items.sort((a,b) => b.published - a.published)

        const episodePicker = window.createQuickPick<EpisodeItem>()
        episodePicker.ignoreFocusOut = true
        episodePicker.title = podcast.title
        episodePicker.placeholder = 'Pick an episode'
        episodePicker.items = items
        episodePicker.buttons = [refreshButton]
        episodePicker.onDidTriggerButton(async btn => {
            if (btn == refreshButton) {
                episodePicker.busy = true
                try {
                    await storage.updatePodcast(feedUrl!)
                } catch (e) {
                    window.showWarningMessage(`Updating the feed failed: ${e}`)
                    return
                } finally {
                    episodePicker.busy = false
                }
                podcast = storage.getPodcast(feedUrl!)
                episodePicker.items = getEpisodeItems(podcast)
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
        episodePicker.show()
        const pick = await episodePickerPromise

        if (!pick) {
            return
        }

        await player.play(feedUrl, pick.guid)
    }))

    disposables.push(commands.registerCommand(NAMESPACE + '.searchPodcasts', async () => {
        const pick = new ListenNotesPodcastSearchQuickPick(cfg.search, listenNotes, log)
        const url = await pick.show()
        if (!url) {
            return
        }
        const realFeedUrl = await listenNotes.resolveRedirect(url)
        commands.executeCommand(NAMESPACE + '.play', realFeedUrl)
    }))

    disposables.push(commands.registerCommand(NAMESPACE + '.searchEpisodes', async () => {
        const pick = new ListenNotesEpisodeSearchQuickPick(cfg.search, listenNotes, log)
        const episode = await pick.show()
        if (!episode) {
            return
        }
        const realFeedUrl = await listenNotes.resolveRedirect(episode.feedUrl)
        const podcast = await storage.fetchPodcast(realFeedUrl, episode.published)
        let match = Object.entries(podcast.episodes).find(
            ([_, ep]) => ep.title === episode.title)
        if (!match) {
            log(`Unable to match "${episode.title}" to an episode in ${realFeedUrl}, trying enclosure URL`)
            
            const realEnclosureUrl = await listenNotes.resolveRedirect(episode.enclosureUrl)
            match = Object.entries(podcast.episodes).find(
                ([_, ep]) => ep.enclosureUrl === realEnclosureUrl)
            if (!match) {
                log(`Unable to match ${realEnclosureUrl} to an episode in ${realFeedUrl}`)
                log(`Listen Notes feed: ${episode.feedUrl}`)
                log(`Listen Notes audio: ${episode.enclosureUrl}`)
                window.showErrorMessage(`Unexpected error, please report an issue ` +
                    `(see View -> Output for error details)`)
                return
            }
        }
        const [realGuid, _] = match
        await player.play(realFeedUrl, realGuid)
    }))
}
