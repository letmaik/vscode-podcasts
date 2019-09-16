import { ExtensionContext, workspace, window, Disposable, commands, Uri, QuickPickItem, QuickInputButton, env, QuickInputButtons, ProgressOptions, ProgressLocation } from 'vscode'

import { NAMESPACE } from './constants'
import { ShellPlayer, ShellPlayerCommand } from './shellPlayer'
import { ListenNotes } from './listenNotes'
import { toHumanDuration, toHumanTimeAgo, readFile, writeFile } from './util'
import { Storage, PodcastMetadata } from './storage'
import { Player } from './player'
import { StatusBar } from './statusBar'
import { Configuration, PlayerStatus } from './types'
import { ListenNotesPodcastSearchQuickPick, ListenNotesEpisodeSearchQuickPick } from './quickpicks/listenNotesSearch'
import * as toOPML from 'opml-generator'
import * as parseOPML from 'node-opml-parser'

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

interface ListenedEpisodeItem extends QuickPickItem {
    feedUrl: string
    guid: string
    lastPlayed: number
}

function getConfig(): Configuration {
    const playerCfg = workspace.getConfiguration('podcasts.player')
    const storageCfg = workspace.getConfiguration('podcasts.storage')
    const searchCfg = workspace.getConfiguration('podcasts.search')
    return {
        player: {
            path: playerCfg.get<string>('path')
        },
        storage: {
            roamingPath: storageCfg.get<string>('roamingPath'),
        },
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

    const log = (msg: string) => outputChannel.appendLine(msg)

    let cfg = getConfig()

    const shellPlayer = new ShellPlayer({
        playerPath: cfg.player.path,
        supportDir: context.asAbsolutePath('extra')
    }, log)

    const storage = new Storage(context.globalStoragePath, cfg.storage.roamingPath, log)
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

    disposables.push(workspace.onDidChangeConfiguration(async e => {
        log('Config changed, reloading')
        cfg = getConfig()
        if (e.affectsConfiguration(NAMESPACE + '.player')) {
            shellPlayer.setPlayerPath(cfg.player.path)
        }
        if (e.affectsConfiguration(NAMESPACE + '.storage')) {
            storage.setRoamingPath(cfg.storage.roamingPath)
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

    disposables.push(commands.registerCommand(NAMESPACE + '.showHistory', async () => {
        const items: ListenedEpisodeItem[] = []
        const meta = storage.getMetadata()
        
        for (const feedUrl in meta.roaming.podcasts) {
            const podcast = storage.getPodcast(feedUrl)
            const podcastRoaming = podcast.roaming!
            if (!podcast.local) {
                // TODO fetch feed on the fly
                continue
            }
            const guids = Object.keys(podcastRoaming.episodes)
            for (const guid of guids) {
                const episode = storage.getEpisode(feedUrl, guid)
                const episodeRoaming = episode.roaming!
                if (!episode.local) {
                    // TODO feed may be outdated, update on the fly
                    continue
                }
                const downloaded = storage.isEpisodeDownloaded(feedUrl, guid) ? ' | $(database)' : ''
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
        const feedUrls = storage.getStarredPodcastUrls()
        // TODO show progress
        // TODO handle errors
        await Promise.all(feedUrls.map(feedUrl => storage.fetchPodcast(feedUrl)))
        const feedItems: PodcastItem[] = feedUrls.map(feedUrl => {
            const podcast = storage.getPodcast(feedUrl)
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

        const importFromOPMLButton: QuickInputButton = {
            iconPath: {
                dark: Uri.file(context.asAbsolutePath('resources/icons/dark/folder-opened.svg')),
                light: Uri.file(context.asAbsolutePath('resources/icons/light/folder-opened.svg'))
            },
            tooltip: 'Import from OPML'
        }

        const exportAsOPMLButton: QuickInputButton = {
            iconPath: {
                dark: Uri.file(context.asAbsolutePath('resources/icons/dark/save.svg')),
                light: Uri.file(context.asAbsolutePath('resources/icons/light/save.svg'))
            },
            tooltip: 'Export as OPML'
        }

        const feedPicker = window.createQuickPick<PodcastItem>()
        feedPicker.ignoreFocusOut = true
        feedPicker.matchOnDescription = true
        feedPicker.title = 'Starred podcasts'
        feedPicker.placeholder = 'Pick a podcast'
        feedPicker.items = feedItems
        feedPicker.buttons = [importFromOPMLButton, exportAsOPMLButton]
        
        feedPicker.onDidTriggerButton(async btn => {
            if (btn == importFromOPMLButton) {
                commands.executeCommand(NAMESPACE + '.importFromOPML')
            } else if (btn == exportAsOPMLButton) {
                commands.executeCommand(NAMESPACE + '.exportAsOPML')
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
        commands.executeCommand(NAMESPACE + '.play', feedUrl, resolveListenNotes, NAMESPACE + '.showStarredPodcasts')
    }))

    disposables.push(commands.registerCommand(NAMESPACE + '.exportAsOPML', async () => {
        const feedUrls = storage.getStarredPodcastUrls()
        // TODO show progress
        // TODO handle errors
        await Promise.all(feedUrls.map(feedUrl => storage.fetchPodcast(feedUrl)))
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
            const podcast = storage.getPodcast(feedUrl)
            return {
                text: podcast.local!.title,
                htmlUrl: podcast.local!.homepageUrl,
                xmlUrl: feedUrl
            }
        })
        const opml = toOPML(header, outlines)
        await writeFile(uri.fsPath, opml)
    }))

    disposables.push(commands.registerCommand(NAMESPACE + '.importFromOPML', async () => {
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
            log(`Error reading OPML file ${path}: ${e}`)
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
                    await storage.fetchPodcast(feedUrl)
                } catch (e) {
                    log(`Feed ${feedUrl} (${item.title}) could not be loaded, see error above`)
                    failed = true
                    continue
                }
                storage.starPodcast(feedUrl, true)
            }
        })
        storage.saveMetadata()
        if (failed) {
            window.showWarningMessage(`Some podcasts failed to import, see log for details.`)
            outputChannel.show()
        } else {
            window.showInformationMessage(`All podcasts successfully imported!`)
        }
    }))

    disposables.push(commands.registerCommand(NAMESPACE + '.play', async (feedUrl: string, resolveListenNotes?: boolean, prevCmd?: string, prevCmdArg?: any) => {
        const getEpisodeItems = (podcast: PodcastMetadata) => {
            const items: EpisodeItem[] = Object.keys(podcast.local!.episodes).map(guid => {
                const episode = storage.getEpisode(feedUrl, guid)
                const episodeLocal = episode.local!
                const downloaded = storage.isEpisodeDownloaded(feedUrl, guid) ? ' | $(database)' : ''
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
            feedUrl = await listenNotes.resolveRedirect(feedUrl)
        }

        // TODO make configurable
        const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
        let podcast = await storage.fetchPodcast(feedUrl, oneWeekAgo)

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
        episodePicker.title = podcast.local!.title
        episodePicker.items = items
        episodePicker.placeholder = 'Pick an episode to play'

        const setButtons = () => {
            const buttons: QuickInputButton[] = []
            buttons.push(storage.isStarredPodcast(feedUrl) ? unstarButton : starButton)
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
                env.openExternal(Uri.parse(podcast.local!.homepageUrl))
            } else if (btn == starButton) {
                storage.starPodcast(feedUrl, true)
                storage.saveMetadata({roaming: true})
                setButtons()
            } else if (btn == unstarButton) {
                storage.starPodcast(feedUrl, false)
                storage.saveMetadata({roaming: true})
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
        let match = Object.entries(podcast.local!.episodes).find(
            ([_, ep]) => ep.title === episode.title)
        if (!match) {
            log(`Unable to match "${episode.title}" to an episode in ${realFeedUrl}, trying enclosure URL`)
            
            const realEnclosureUrl = await listenNotes.resolveRedirect(episode.enclosureUrl)
            match = Object.entries(podcast.local!.episodes).find(
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
