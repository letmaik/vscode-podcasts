import { ShellPlayer, ShellPlayerCommand, ShellPlayerStatus } from "./shellPlayer";
import { Storage } from "./storage";
import { window, Disposable, StatusBarItem } from "vscode";
import { StatusBar, StatusBarStatus } from "./statusBar";

const StatusMapping = {
    [ShellPlayerStatus.PLAYING]: StatusBarStatus.PLAYING,
    [ShellPlayerStatus.PAUSED]: StatusBarStatus.PAUSED,
    [ShellPlayerStatus.STOPPED]: StatusBarStatus.STOPPED
}

export class Player {
    private currentEpisodeFeedUrl?: string
    private currentEpisodeGuid?: string

    private shellPlayerQueryIntervalId: NodeJS.Timeout

    constructor(private shellPlayer: ShellPlayer, private storage: Storage, private statusBar: StatusBar, 
            private log: (msg: string) => void, private disposables: Disposable[]) {
        
        disposables.push(this.shellPlayer.onStatusChange(shellPlayerStatus => {
            const statusBarStatus = StatusMapping[shellPlayerStatus]
            this.statusBar.update({status: statusBarStatus})
            if (shellPlayerStatus == ShellPlayerStatus.PLAYING) {
                const sendUpdate = () => {
                    this.statusBar.update({
                        status: StatusBarStatus.PLAYING,
                        duration: this.shellPlayer.duration,
                        elapsed: this.shellPlayer.position
                    })
                }
                sendUpdate()
                this.shellPlayerQueryIntervalId = setInterval(sendUpdate, 1000)
            } else {
                clearInterval(this.shellPlayerQueryIntervalId)
            }
        }))
    }

    async play(feedUrl: string, guid: string) {
        this.currentEpisodeFeedUrl = feedUrl
        this.currentEpisodeGuid = guid
        
        this.statusBar.update({status: StatusBarStatus.DOWNLOADING})
        const enclosurePath = await this.storage.fetchEpisodeEnclosure(feedUrl, guid, progress => {
            this.statusBar.update({
                status: StatusBarStatus.DOWNLOADING,
                downloadProgress: progress
            })
        })
        
        this.statusBar.update({status: StatusBarStatus.OPENING})
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