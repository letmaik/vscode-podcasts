import { ExtensionContext, workspace, window, Disposable, commands } from 'vscode'

import { NAMESPACE, COMMANDS } from './constants'
import { ShellPlayer } from './shellPlayer'
import { ListenNotes } from './listenNotes'
import { Storage } from './storage'
import { Player } from './player'
import { StatusBar } from './statusBar'
import { Configuration, PlayerStatus } from './types'
import { SearchPodcastsCommand } from './commands/searchPodcasts';
import { Command } from './commands/command';
import { SearchEpisodesCommand } from './commands/searchEpisodes';
import { ExportAsOPMLCommand } from './commands/exportAsOPML';
import { ImportFromOPMLCommand } from './commands/importFromOPML';
import { ShowStarredPodcastsCommand } from './commands/showStarredPodcasts';
import { Resources } from './resources';
import { AddByFeedUrlCommand } from './commands/addByFeedUrl';
import { ShowHistoryCommand } from './commands/showHistory';
import { ShowPodcastCommand } from './commands/showPodcast';
import { PlayerCommand } from './commands/player';
import { ShowPlayerCommandsCommand } from './commands/showPlayerCommands';
import { FileWatcher } from './util';
import { ShowMainCommandsCommand } from './commands/showMainCommands';

function getConfig(): Configuration {
    const playerCfg = workspace.getConfiguration(NAMESPACE + '.player')
    const storageCfg = workspace.getConfiguration(NAMESPACE + '.storage')
    const searchCfg = workspace.getConfiguration(NAMESPACE + '.search')
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

    function log(msg: string | true) {
        if (msg === true) {
            outputChannel.show()
        } else {
            outputChannel.appendLine(msg)
        }
    }

    const cfg = getConfig()
    const resources = new Resources(context)

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
            commands.executeCommand('setContext',
                                    `${NAMESPACE}.playerStatus`,
                                    `${PlayerStatus[state.status]}`)
            lastStatus = state.status
        }
    }))

    function registerCommand(cmd: Command) {
        disposables.push(commands.registerCommand(cmd.COMMAND, cmd.run, cmd))
    }

    registerCommand(new ShowMainCommandsCommand(log))
    const searchPodcastsCmd = new SearchPodcastsCommand(cfg.search, listenNotes, log)
    const searchEpisodesCmd = new SearchEpisodesCommand(cfg.search, listenNotes, storage, player, log)
    registerCommand(searchPodcastsCmd)
    registerCommand(searchEpisodesCmd)
    registerCommand(new ShowStarredPodcastsCommand(storage, resources, log))
    registerCommand(new ShowHistoryCommand(storage, player, log))
    registerCommand(new ShowPodcastCommand(storage, resources, player, listenNotes, log))
    registerCommand(new AddByFeedUrlCommand(storage, log))
    registerCommand(new ImportFromOPMLCommand(storage, log))
    registerCommand(new ExportAsOPMLCommand(storage, log))
    registerCommand(new ShowPlayerCommandsCommand(player, shellPlayer, log))

    function registerPlayerCommand(cmd: string, fn: (player: Player) => Promise<void>) {
        registerCommand(new PlayerCommand(cmd, player, fn, log))
    }

    registerPlayerCommand(COMMANDS.OPEN_WEBSITE, async p => await p.openWebsite())
    registerPlayerCommand(COMMANDS.CANCEL_DOWNLOAD, async p => p.cancelDownload())
    registerPlayerCommand(COMMANDS.PAUSE, async p => p.pause())
    registerPlayerCommand(COMMANDS.STOP, async p => p.stop())
    registerPlayerCommand(COMMANDS.RESTART, async p => await p.restart())
    registerPlayerCommand(COMMANDS.SKIP_BACKWARD, async p => p.skipBackward())
    registerPlayerCommand(COMMANDS.SKIP_FORWARD, async p => p.skipForward())
    registerPlayerCommand(COMMANDS.SLOWDOWN, async p => p.slowdown())
    registerPlayerCommand(COMMANDS.SPEEDUP, async p => p.speedup())

    // watch for file changes of roaming metadata, e.g. sync via Dropbox
    const roamingPathWatcher = new FileWatcher(storage.getRoamingPath(), () => {
        const lastSaved = storage.getRoamingMetadataLastSaved()
        const now = new Date()
        if (now.getTime() - lastSaved.getTime() < 5 * 1000) {
            // ignore changes by ourselves
            return
        }
        log('External update to roaming metadata detected')
        storage.loadMetadata({roaming: true})
    })
    disposables.push(roamingPathWatcher.disposable)

    disposables.push(workspace.onDidChangeConfiguration(async e => {
        log('Config changed, reloading')
        const affected = (section: string) => e.affectsConfiguration(`${NAMESPACE}.${section}`)
        const cfg = getConfig()
        if (affected('player')) {
            shellPlayer.setPlayerPath(cfg.player.path)
        }
        if (affected('storage')) {
            storage.setRoamingPath(cfg.storage.roamingPath)
            storage.loadMetadata({roaming: true})
            roamingPathWatcher.update(storage.getRoamingPath())
        }
        if (affected('search')) {
            searchPodcastsCmd.updateSearchConfiguration(cfg.search)
            searchEpisodesCmd.updateSearchConfiguration(cfg.search)
        }
    }))
}
