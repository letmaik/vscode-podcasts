import * as util from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ExtensionContext, workspace, window, Disposable, commands, Uri, QuickPickItem, StatusBarAlignment, QuickInputButtons, QuickInput, QuickInputButton } from 'vscode'
import * as requestp from 'request-promise-native';
import * as parsePodcast_ from 'node-podcast-parser';

import {mkdirp} from './3rdparty/util'
import { NAMESPACE } from './constants'
import { ShellPlayer, ShellPlayerCommand } from './shellPlayer';
import * as listenNotes from './listen-notes'
import { toHumanDuration, toHumanTimeAgo, downloadFile } from './util';
import { Storage, PodcastMetadata } from './storage';

const parsePodcast = util.promisify(parsePodcast_);

interface EpisodeItem extends QuickPickItem {
    guid: string
}

interface PodcastItem extends QuickPickItem {
    url: string
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

const COMMAND_MAPPING = {
    'pause': ShellPlayerCommand.PAUSE,
    'skipBackward': ShellPlayerCommand.SKIP_BACKWARD,
    'skipForward': ShellPlayerCommand.SKIP_FORWARD,
    'slowdown': ShellPlayerCommand.SLOWDOWN,
    'speedup': ShellPlayerCommand.SPEEDUP,
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

    const player = new ShellPlayer({
        playerPath: cfg.player,
        supportDir: context.asAbsolutePath('extra')
    }, log)

    const storage = new Storage(context.globalStoragePath, log)
    await storage.loadMetadata()

    // TODO allow to add podcasts from search to the config

    workspace.onDidChangeConfiguration(e => {
        cfg = getConfig()
        if (e.affectsConfiguration(NAMESPACE + '.player')) {
            player.setPlayerPath(cfg.player)
        }
    })

    commands.registerCommand(NAMESPACE + '.main', async () => {
        // TODO go to main menu dropdown
    })

    const statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 100)
    statusBarItem.command = NAMESPACE + '.main'
    statusBarItem.text = '$(radio-tower) 33 min left'
    statusBarItem.tooltip = 'Podcast controls'
    statusBarItem.show()
    disposables.push(statusBarItem)

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

        const enclosurePath = await storage.fetchEpisodeEnclosure(feedUrl, pick.guid)

        try {
            await player.play(enclosurePath,
                0,
                e => {
                    console.error(e)
                    window.showErrorMessage(e.message)
                })
        } catch (e) {
            console.error(e)
            window.showErrorMessage(e.message)
        }
    }))

    for (const cmdName of Object.keys(COMMAND_MAPPING)) {
        disposables.push(commands.registerCommand(NAMESPACE + '.' + cmdName, async () => {
            try {
                player.sendCommand(COMMAND_MAPPING[cmdName])
            } catch (e) {
                console.error(e)
                window.showErrorMessage(e.message)
            }
        }))
    }

    disposables.push(commands.registerCommand(NAMESPACE + '.stop', async () => {
        try {
            player.stop()
        } catch (e) {
            console.error(e)
            window.showErrorMessage(e.message)
        }
    }))

    disposables.push(commands.registerCommand(NAMESPACE + '.searchEpisodes', async (query?: string) => {
        if (!query) {
            const input = await window.showInputBox({
                prompt: 'Enter a search term',
                placeHolder: 'python'
            })
            if (!input) {
                return
            }
            query = input
        }

        let data: listenNotes.EpisodeResult[]
        try {
            data = await listenNotes.searchEpisodes(query, cfg.search)
        } catch (e) {
            console.error(e)
            window.showErrorMessage(e.message)
            return
        }

        if (data.length == 0) {
            window.showInformationMessage('No episodes found, try a different keyword.')
            return
        }

        const items: EpisodeItem[] = data.map(episode => ({
            label: episode.title_original,
            description: episode.description_original,
            detail: toHumanDuration(episode.audio_length_sec) +
                ' | ' + toHumanTimeAgo(episode.pub_date_ms) +
                ' | ' + episode.podcast_title_original,
            url: episode.audio,
            guid: episode.id
        }));

        const pick = await window.showQuickPick(items, {
            ignoreFocusOut: true,
            placeHolder: 'Pick an episode'
        })
        if (!pick) {
            return
        }
        // TODO do something

    }))

    disposables.push(commands.registerCommand(NAMESPACE + '.searchPodcasts', async (query?: string) => {
        if (!query) {
            const input = await window.showInputBox({
                prompt: 'Enter a search term',
                placeHolder: 'python'
            })
            if (!input) {
                return
            }
            query = input
        }

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
        }

        if (data.length == 0) {
            window.showInformationMessage('No podcasts found, try a different keyword.')
            return
        }

        const items: PodcastItem[] = data.map(podcast => ({
            label: podcast.title_original,
            description: `Last episode: ` + toHumanTimeAgo(podcast.latest_pub_date_ms),
            detail: podcast.description_original,
            url: podcast.rss
        }));

        const pick = await window.showQuickPick(items, {
            ignoreFocusOut: true,
            placeHolder: 'Pick a podcast'
        })
        if (!pick) {
            return
        }

        // TODO resolve feed URL and figure out real guid

        commands.executeCommand(NAMESPACE + '.play', pick.url)
    }))
}
