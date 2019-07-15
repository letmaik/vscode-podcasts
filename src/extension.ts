import { ExtensionContext, workspace, window, Disposable, commands, Uri, QuickPickItem, StatusBarAlignment, QuickInputButtons, QuickInput, QuickInputButton } from 'vscode'

import { NAMESPACE } from './constants'
import { ShellPlayer } from './shellPlayer';
import * as listenNotes from './listen-notes'
import { toHumanDuration, toHumanTimeAgo } from './util';
import { Storage, PodcastMetadata } from './storage';
import { Player } from './player';
import { StatusBar } from './statusBar';

interface EpisodeItem extends QuickPickItem {
    guid: string
}

interface PodcastItem extends QuickPickItem {
    url: string
}

interface CommandItem extends QuickPickItem {
    cmd: string
}

interface SearchConfiguration {
    genres: string[]
    sortByDate: boolean
    language: string
    minimumLength: number
    maximumLength: number
}

interface Feed {
    title: string
    url: string
}

interface Configuration {
    feeds: Feed[]
    player: string | undefined
    search: SearchConfiguration
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
            minimumLength: searchCfg.get<number>('minLength')!,
            maximumLength: searchCfg.get<number>('maxLength')!,
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

    // TODO allow to add podcasts from search to the config

    workspace.onDidChangeConfiguration(e => {
        cfg = getConfig()
        if (e.affectsConfiguration(NAMESPACE + '.player')) {
            shellPlayer.setPlayerPath(cfg.player)
        }
    })

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

    commands.registerCommand(NAMESPACE + '.main', async () => {
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
    })

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
            });

            const feedPick = await window.showQuickPick(feedItems, {
                ignoreFocusOut: true,
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
                const downloaded = guid in podcast.downloaded ? ' | $(database)' : ''
                return {
                    label: episode.title,
                    description: episode.description,
                    detail: toHumanDuration(episode.duration) + ' | ' + toHumanTimeAgo(episode.published) + downloaded,
                    guid: guid
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

        const episodePicker = window.createQuickPick<EpisodeItem>()
        episodePicker.ignoreFocusOut = true
        episodePicker.title = podcast.title
        episodePicker.placeholder = 'Pick an episode'
        episodePicker.items = getEpisodeItems(podcast)
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

    disposables.push(commands.registerCommand(NAMESPACE + '.searchEpisodes', async () => {
        const episodePicker = window.createQuickPick<EpisodeItem>()
        episodePicker.title = 'Search episodes using Listen Notes'
        episodePicker.ignoreFocusOut = true
        episodePicker.placeholder = 'Enter a search term'
        episodePicker.onDidChangeValue(async query => {
            episodePicker.items = []
            episodePicker.busy = true
            let data: listenNotes.EpisodeResult[]
            try {
                data = await listenNotes.searchEpisodes(query, cfg.search)
            } catch (e) {
                console.error(e)
                window.showErrorMessage(e.message)
                return
            } finally {
                episodePicker.busy = false
            }
    
            episodePicker.items = data.map(episode => ({
                label: episode.title_original,
                description: episode.description_original,
                detail: toHumanDuration(episode.audio_length_sec) +
                    ' | ' + toHumanTimeAgo(episode.pub_date_ms) +
                    ' | ' + episode.podcast_title_original,
                url: episode.audio,
                guid: episode.id
            }));
        })
        const pickerPromise = new Promise<EpisodeItem | undefined>((resolve, _) => {
            episodePicker.onDidAccept(() => {
                const items = episodePicker.selectedItems
                if (items.length > 0) {
                    resolve(episodePicker.selectedItems[0])
                    episodePicker.dispose()
                }
            })
            episodePicker.onDidHide(() => {
                resolve(undefined)
                episodePicker.dispose()
            })
        })
        episodePicker.show()
        const pick = await pickerPromise

        if (!pick) {
            return
        }

        // TODO do something
    }))

    disposables.push(commands.registerCommand(NAMESPACE + '.searchPodcasts', async (query?: string) => {
        const podcastPicker = window.createQuickPick<PodcastItem>()
        podcastPicker.title = 'Search podcasts using Listen Notes'
        podcastPicker.ignoreFocusOut = true
        podcastPicker.placeholder = 'Enter a search term'
        podcastPicker.onDidChangeValue(async query => {
            podcastPicker.items = []
            podcastPicker.busy = true

            // Currently we only want to support sorting episodes by date.
            const opts = Object.assign({}, cfg.search);
            opts.sortByDate = false

            let data: listenNotes.PodcastResult[]
            try {
                data = await listenNotes.searchPodcasts(query, opts)
            } catch (e) {
                console.error(e)
                window.showErrorMessage(e.message)
                return
            } finally {
                podcastPicker.busy = false
            }

            podcastPicker.items = data.map(podcast => ({
                label: podcast.title_original,
                description: `Last episode: ` + toHumanTimeAgo(podcast.latest_pub_date_ms),
                detail: podcast.description_original,
                url: podcast.rss
            }))
        })
        const pickerPromise = new Promise<PodcastItem | undefined>((resolve, _) => {
            podcastPicker.onDidAccept(() => {
                const items = podcastPicker.selectedItems
                if (items.length > 0) {
                    resolve(podcastPicker.selectedItems[0])
                    podcastPicker.dispose()
                }
            })
            podcastPicker.onDidHide(() => {
                resolve(undefined)
                podcastPicker.dispose()
            })
        })
        podcastPicker.show()
        const pick = await pickerPromise

        if (!pick) {
            return
        }
        
        // TODO resolve feed URL and figure out real guid

        commands.executeCommand(NAMESPACE + '.play', pick.url)
    }))
}
