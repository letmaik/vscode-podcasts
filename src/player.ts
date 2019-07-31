import { ShellPlayer, ShellPlayerCommand, ShellPlayerStatus } from "./shellPlayer";
import { Storage } from "./storage";
import { window, Disposable, CancellationTokenSource } from "vscode";
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

    private downloadCancellationTokenSource?: CancellationTokenSource
    private isDownloadInProgress = false

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
                if (shellPlayerStatus == ShellPlayerStatus.STOPPED) {
                    this.storeListeningStatus()
                }
            }
        }))

        disposables.push({
            dispose: () => {
                clearInterval(this.shellPlayerQueryIntervalId)
                this.storeListeningStatus()
            }
        })
    }

    private async storeListeningStatus() {
        if (!this.currentEpisodeFeedUrl) {
            return
        }
        this.log(`Storing listening status`)
        if (this.shellPlayer.position === this.shellPlayer.duration) {
            this.storage.storeListeningStatus(this.currentEpisodeFeedUrl, this.currentEpisodeGuid!, true)
        } else {
            this.storage.storeListeningStatus(this.currentEpisodeFeedUrl, this.currentEpisodeGuid!, false, this.shellPlayer.position)
        }
    }

    cancelDownload() {
        if (!this.isDownloadInProgress) {
            window.showInformationMessage('No download in progress')
            return
        }
        this.downloadCancellationTokenSource!.cancel()
    }

    async play(feedUrl: string, guid: string) {
        if (this.isDownloadInProgress) {
            window.showWarningMessage('Cannot download multiple episodes in parallel')
            return
        } else if (this.downloadCancellationTokenSource) {
            this.downloadCancellationTokenSource.dispose()
        }
        this.currentEpisodeFeedUrl = feedUrl
        this.currentEpisodeGuid = guid
        this.isDownloadInProgress = true
        this.downloadCancellationTokenSource = new CancellationTokenSource()
        const token = this.downloadCancellationTokenSource.token
        
        try {
            this.statusBar.update({status: StatusBarStatus.DOWNLOADING})
            const enclosurePath = await this.storage.fetchEpisodeEnclosure(feedUrl, guid,
                progress => {
                    this.statusBar.update({
                        status: StatusBarStatus.DOWNLOADING,
                        downloadProgress: progress
                    })
                },
                token
            )
            this.isDownloadInProgress = false

            let startPosition = this.storage.getLastListeningPosition(feedUrl, guid)
            if (startPosition > 0 && !this.shellPlayer.supportsStartOffset()) {
                startPosition = 0
                window.showWarningMessage(`Playing from beginning, player does not support arbitrary positions`)
            }

            const duration = this.storage.getEpisodeDuration(feedUrl, guid)
            
            this.statusBar.update({status: StatusBarStatus.OPENING})
            
            await this.shellPlayer.play(enclosurePath,
                startPosition,
                duration,
                e => {
                    console.error(e)
                    window.showErrorMessage(e.message)
                })
        } catch (e) {
            console.error(e)
            window.showErrorMessage(e.message)
            this.statusBar.update({status: StatusBarStatus.STOPPED})
            this.isDownloadInProgress = false
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