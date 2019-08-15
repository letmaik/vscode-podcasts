import { ExtensionContext, workspace, window, Disposable, commands, Uri, QuickPickItem, QuickInputButton, env, QuickInputButtons } from 'vscode'

import { NAMESPACE } from './constants'
import { ShellPlayer, ShellPlayerCommand } from './shellPlayer';
import { ListenNotes } from './listenNotes'
import { toHumanDuration, toHumanTimeAgo } from './util';
import { Storage, PodcastMetadata } from './storage';
import { Player } from './player';
import { StatusBar } from './statusBar';
import { Configuration, StarredFeed, PlayerStatus } from './types';
import { ListenNotesPodcastSearchQuickPick, ListenNotesEpisodeSearchQuickPick } from './quickpicks/listenNotesSearch';

interface CommandItem extends QuickPickItem {
    cmd: string
}

interface EpisodeItem extends QuickPickItem {
    guid: string
    published?: number
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
        starred: rootCfg.get<StarredFeed[]>('starred')!,
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

function updateConfig({starred}: {starred?: StarredFeed[]}) {
    const rootCfg = workspace.getConfiguration('podcasts')
    if (starred) {
        rootCfg.update('starred', starred, true)
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
    const player = new Player(shellPlayer, storage, log, disposables)
    const listenNotes = new ListenNotes(log)

    let lastStatus = PlayerStatus.STOPPED
    disposables.push(player.onStateChange(state => {
        statusBar.update(state)
        if (state.status !== lastStatus) {
            commands.executeCommand('setContext', `${NAMESPACE}.playerStatus`, `${PlayerStatus[state.status]}`)
            lastStatus = state.status
        }
    }))

    disposables.push(workspace.onDidChangeConfiguration(e => {
        log('Config changed, reloading')
        cfg = getConfig()
        if (e.affectsConfiguration(NAMESPACE + '.player')) {
            shellPlayer.setPlayerPath(cfg.player)
        }
    }))

    const registerPlayerCommand = (cmd: string, fn: (player: Player) => Promise<void>) => {
        disposables.push(commands.registerCommand(NAMESPACE + '.' + cmd, async () => {
            try {
                await fn(player)
            } catch (e) {
                console.error(e)
                window.showErrorMessage(e.message)
            }
        }))
    }

    registerPlayerCommand('openWebsite', async p => await p.openWebsite())
    registerPlayerCommand('cancelDownload', async p => p.cancelDownload())
    registerPlayerCommand('pause', async p => p.pause())
    registerPlayerCommand('stop', async p => p.stop())
    registerPlayerCommand('restart', async p => await p.restart())
    registerPlayerCommand('skipBackward', async p => p.skipBackward())
    registerPlayerCommand('skipForward', async p => p.skipForward())
    registerPlayerCommand('slowdown', async p => p.slowdown())
    registerPlayerCommand('speedup', async p => p.speedup())

    disposables.push(commands.registerCommand(NAMESPACE + '.main', async () => {
        const items: CommandItem[] = []
        const status = player.status
        const supportsCmds = shellPlayer.supportsCommands()
        // NOTE: When changing conditions, also change in package.json.
        if (status === PlayerStatus.DOWNLOADING) {
            items.push({
                cmd: 'cancelDownload',
                label: 'Cancel download'
            })
        }
        if (status !== PlayerStatus.STOPPED) {
            const website = player.getWebsite()
            if (website) {
                items.push({
                    cmd: 'openWebsite',
                    label: 'Open episode website',
                    description: website
                })
            }
        }
        if (status === PlayerStatus.PLAYING || status === PlayerStatus.PAUSED) {
            if (supportsCmds) {
                items.push({
                    cmd: 'pause',
                    label: status === PlayerStatus.PLAYING ? 'Pause' : 'Unpause'
                })
            }
            items.push({
                cmd: 'stop',
                label: 'Stop'
            })
            items.push({
                cmd: 'restart',
                label: 'Restart'
            })
        }
        if (status === PlayerStatus.PLAYING) {
            if (supportsCmds) {
                const skipBwdSecs = shellPlayer.getCommandInfo(ShellPlayerCommand.SKIP_BACKWARD)
                const skipFwdSecs = shellPlayer.getCommandInfo(ShellPlayerCommand.SKIP_FORWARD)
                const slowdownRatio = shellPlayer.getCommandInfo(ShellPlayerCommand.SLOWDOWN)
                const speedupRatio = shellPlayer.getCommandInfo(ShellPlayerCommand.SPEEDUP)
                items.push(...[{
                    cmd: 'skipBackward',
                    label: 'Skip backward',
                    description: `${skipBwdSecs}s`
                }, {
                    cmd: 'skipForward',
                    label: 'Skip forward',
                    description: `+${skipFwdSecs}s`
                }, {
                    cmd: 'slowdown',
                    label: 'Slow down',
                    description: `${Math.round(slowdownRatio*100)}%`
                }, {
                    cmd: 'speedup',
                    label: 'Speed up',
                    description: `+${Math.round(speedupRatio*100)}%`
                }])
            }
        }
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
                        (episode.published ? ' | ' + toHumanTimeAgo(episode.published) : '') + 
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

    disposables.push(commands.registerCommand(NAMESPACE + '.showStarredPodcasts', async () => {
        const feedItems: PodcastItem[] = cfg.starred.map(feed => {
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
        const feedUrl = feedPick.url
        const resolveListenNotes = false
        commands.executeCommand(NAMESPACE + '.play', feedUrl, resolveListenNotes, NAMESPACE + '.showStarredPodcasts')
    }))

    disposables.push(commands.registerCommand(NAMESPACE + '.play', async (feedUrl: string, resolveListenNotes?: boolean, prevCmd?: string, prevCmdArg?: any) => {
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
                        (episode.published ? ' | ' + toHumanTimeAgo(episode.published) : '') +
                        downloaded,
                    guid: guid,
                    published: episode.published
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
            feedUrl = await listenNotes.resolveRedirect(feedUrl)
        }

        let podcast = await storage.fetchPodcast(feedUrl)

        const refreshButton: QuickInputButton = {
            iconPath: {
                dark: Uri.file(context.asAbsolutePath('resources/icons/dark/refresh.svg')),
                light: Uri.file(context.asAbsolutePath('resources/icons/light/refresh.svg'))
            },
            tooltip: 'Refresh Feed'
        }

        const websiteButton: QuickInputButton = {
            iconPath: {
                dark: Uri.file(context.asAbsolutePath('resources/icons/dark/globe.svg')),
                light: Uri.file(context.asAbsolutePath('resources/icons/light/globe.svg'))
            },
            tooltip: 'Open Podcast Website'
        }

        const starButton: QuickInputButton = {
            iconPath: {
                dark: Uri.file(context.asAbsolutePath('resources/icons/dark/star-empty.svg')),
                light: Uri.file(context.asAbsolutePath('resources/icons/light/star-empty.svg'))
            },
            tooltip: 'Add to Starred Podcasts'
        }

        const unstarButton: QuickInputButton = {
            iconPath: {
                dark: Uri.file(context.asAbsolutePath('resources/icons/dark/star.svg')),
                light: Uri.file(context.asAbsolutePath('resources/icons/light/star.svg'))
            },
            tooltip: 'Remove from Starred Podcasts'
        }

        const items = getEpisodeItems(podcast)
        if (!items.some((item) => item.published === undefined)) {
            items.sort((a,b) => b.published! - a.published!)
        }

        episodePicker.busy = false
        episodePicker.title = podcast.title
        episodePicker.items = items
        episodePicker.placeholder = 'Pick an episode'

        const setButtons = (isStarred?: boolean) => {
            const buttons: QuickInputButton[] = []
            if (isStarred === undefined) {
                isStarred = cfg.starred.some(f => f.url === feedUrl)
            }
            buttons.push(isStarred ? unstarButton : starButton)
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
                    await storage.updatePodcast(feedUrl!)
                } catch (e) {
                    window.showWarningMessage(`Updating the feed failed: ${e}`)
                    return
                } finally {
                    episodePicker.busy = false
                }
                podcast = storage.getPodcast(feedUrl!)
                episodePicker.items = getEpisodeItems(podcast)
            } else if (btn == websiteButton) {
                env.openExternal(Uri.parse(podcast.homepageUrl))
            } else if (btn == starButton) {
                updateConfig({starred: [{
                    title: podcast.title,
                    url: feedUrl!
                }].concat(cfg.starred)})
                setButtons(true)
            } else if (btn == unstarButton) {
                updateConfig({starred: cfg.starred.filter(p => p.url !== feedUrl)})
                setButtons(false)
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

        await player.play(feedUrl, pick.guid)
    }))

    disposables.push(commands.registerCommand(NAMESPACE + '.searchPodcasts', async (query?: string) => {
        const pick = new ListenNotesPodcastSearchQuickPick(cfg.search, listenNotes, query, log)
        const url = await pick.show()
        if (!url) {
            return
        }
        const resolveListenNotes = true
        commands.executeCommand(NAMESPACE + '.play', url, resolveListenNotes, NAMESPACE + '.searchPodcasts', pick.lastQuery)
    }))

    disposables.push(commands.registerCommand(NAMESPACE + '.searchEpisodes', async (query?: string) => {
        const pick = new ListenNotesEpisodeSearchQuickPick(cfg.search, listenNotes, query, log)
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
