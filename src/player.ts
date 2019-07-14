import { ShellPlayer, ShellPlayerCommand } from "./shellPlayer";
import { Storage } from "./storage";
import { window, StatusBarAlignment, Disposable, StatusBarItem } from "vscode";
import { NAMESPACE } from "./constants";
import { toHumanDuration } from "./util";

export class Player {
    private currentEpisodeFeedUrl?: string
    private currentEpisodeGuid?: string

    private statusBarItem?: StatusBarItem
    private statusBarInterval?: NodeJS.Timeout

    constructor(private shellPlayer: ShellPlayer, private storage: Storage, private log: (msg: string) => void, private disposables: Disposable[]) {

    }

    private createStatusBarItem() {
        // TODO encapsulate into separate component
        const statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 100)
        const prefix = '$(radio-tower) '
        statusBarItem.command = NAMESPACE + '.main'
        statusBarItem.text = prefix
        statusBarItem.show()
        this.statusBarItem = statusBarItem
        this.disposables.push(statusBarItem)

        this.statusBarInterval = setInterval(() => {
            const pos = this.shellPlayer.getPosition()
            const total = this.shellPlayer.duration
            statusBarItem.text = prefix + toHumanDuration(total - pos) + ' left'
        }, 1000)
    }

    async play(feedUrl: string, guid: string) {
        this.currentEpisodeFeedUrl = feedUrl
        this.currentEpisodeGuid = guid

        this.createStatusBarItem()

        const enclosurePath = await this.storage.fetchEpisodeEnclosure(feedUrl, guid)
        
        const startPosition = 0
        try {
            await this.shellPlayer.play(enclosurePath,
                startPosition,
                e => {
                    console.error(e)
                    window.showErrorMessage(e.message)
                })
        } catch (e) {
            console.error(e)
            window.showErrorMessage(e.message)
        }
    }

    stop() {
        this.shellPlayer.stop()
    }

    pause() {
        this.shellPlayer.sendCommand(ShellPlayerCommand.PAUSE)
    }

    skipBackward() {
        this.shellPlayer.sendCommand(ShellPlayerCommand.SKIP_BACKWARD)
    }

    skipForward() {
        this.shellPlayer.sendCommand(ShellPlayerCommand.SKIP_FORWARD)
    }

    slowdown() {
        this.shellPlayer.sendCommand(ShellPlayerCommand.SLOWDOWN)
    }

    speedup() {
        this.shellPlayer.sendCommand(ShellPlayerCommand.SPEEDUP)
    }

}