import * as util from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ExtensionContext, workspace, window, Disposable, commands, Uri, QuickPickItem, StatusBarAlignment } from 'vscode'
import * as requestp from 'request-promise-native';
import * as parsePodcast_ from 'node-podcast-parser';

import {mkdirp} from './3rdparty/util'
import { NAMESPACE } from './constants'
import * as audio from './audio';
import * as listenNotes from './listen-notes'
import { toHumanDuration, toHumanTimeAgo, downloadFile } from './util';

const parsePodcast = util.promisify(parsePodcast_);

interface EpisodeItem extends QuickPickItem {
    url: string
    guid?: string
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

interface Configuration {
    feeds: {[title: string]: string} // title -> URL
    player: string | undefined
    search: SearchConfiguration
}

const COMMAND_MAPPING = {
    'pause': audio.Command.PAUSE,
    'skipBackward': audio.Command.SKIP_BACKWARD,
    'skipForward': audio.Command.SKIP_FORWARD,
    'slowdown': audio.Command.SLOWDOWN,
    'speedup': audio.Command.SPEEDUP,
}

function getConfig(): Configuration {
    const rootCfg = workspace.getConfiguration('podcasts')
    const searchCfg = workspace.getConfiguration('podcasts.search')
    return {
        feeds: rootCfg.get<{[title: string]: string}>('feeds')!,
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

    const player = new audio.Player({
        player: cfg.player,
        supportDir: context.asAbsolutePath('extra')
    }, log)

    const audioStorageDir = path.join(context.globalStoragePath, 'audio')
    await mkdirp(audioStorageDir)

    // TODO allow to add podcasts from search to the config

    workspace.onDidChangeConfiguration(e => {
        cfg = getConfig()
        if (e.affectsConfiguration(NAMESPACE + '.player')) {
            player.setPlayer(cfg.player)
        }
    })

    commands.registerCommand(NAMESPACE + '.main', async () => {
        // TODO go to main menu dropdown
    })

    const statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 100)
    statusBarItem.command = NAMESPACE + '.main'
    statusBarItem.text = '$(radio-tower) 33 min'
    statusBarItem.tooltip = 'Podcast controls'
    statusBarItem.show()
    disposables.push(statusBarItem)

    disposables.push(commands.registerCommand(NAMESPACE + '.play', async (feedUrl?: string) => {
        if (!feedUrl) {
            const feedItems: PodcastItem[] = Object.keys(cfg.feeds).map(title => ({
                label: title,
                url: cfg.feeds[title]
            }));

            const feedPick = await window.showQuickPick(feedItems, {
                ignoreFocusOut: true,
                placeHolder: 'Pick a podcast'
            })
            if (!feedPick) {
                return
            }
            feedUrl = feedPick.url
        }

        const data = await requestp({uri: feedUrl, json: true})
        const podcast = await parsePodcast(data)

        const items: EpisodeItem[] = podcast.episodes.map(episode => ({
            label: episode.title,
            description: episode.description,
            detail: toHumanDuration(episode.duration) + ' | ' + toHumanTimeAgo(episode.published),
            url: episode.enclosure.url,
            guid: episode.guid
        }));

        const pick = await window.showQuickPick(items, {
            ignoreFocusOut: true,
            placeHolder: 'Pick an episode'
        })
        if (!pick) {
            return
        }

        const hash = crypto.createHash('md5').update(pick.guid || pick.url).digest('hex')
        const ext = path.extname(pick.url) || '.mp3'
        const filename = hash + ext
        const audioPath = path.join(audioStorageDir, filename)

        if (!fs.existsSync(audioPath)) {
            log(`Downloading ${pick.url} to ${audioPath}`)
            await downloadFile(pick.url, audioPath)
        }

        try {
            await player.play(audioPath,
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

        commands.executeCommand(NAMESPACE + '.play', pick.url)
    }))
}
