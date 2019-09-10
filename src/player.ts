import { ShellPlayer, ShellPlayerCommand, ShellPlayerStatus } from "./shellPlayer";
import { Storage } from "./storage";
import { window, Disposable, CancellationTokenSource, env, Uri, EventEmitter } from "vscode";
import { PlayerStatus, PlayerState } from "./types";

const StatusMapping = {
    [ShellPlayerStatus.PLAYING]: PlayerStatus.PLAYING,
    [ShellPlayerStatus.PAUSED]: PlayerStatus.PAUSED,
    [ShellPlayerStatus.STOPPED]: PlayerStatus.STOPPED
}

export class Player {
    private _onStateChange = new EventEmitter<PlayerState>()
    onStateChange = this._onStateChange.event

    private currentEpisodeFeedUrl?: string
    private currentEpisodeGuid?: string

    private shellPlayerQueryIntervalId: NodeJS.Timeout

    private downloadCancellationTokenSource?: CancellationTokenSource

    private _state: PlayerState = {
        status: PlayerStatus.STOPPED
    }

    private get state() {
        return this._state
    }

    private set state(v: PlayerState) {
        this._state = v
        this._onStateChange.fire(v)
    }

    get status(): PlayerStatus {
        return this.state.status
    }

    constructor(private shellPlayer: ShellPlayer, private storage: Storage,  
            private log: (msg: string) => void, private disposables: Disposable[]) {
        
        disposables.push(this.shellPlayer.onStatusChange(shellPlayerStatus => {
            const status = StatusMapping[shellPlayerStatus]
            this.state = { status }
            if (status == PlayerStatus.PLAYING) {
                const updateState = () => {
                    this.state = {
                        status: PlayerStatus.PLAYING,
                        duration: this.shellPlayer.duration,
                        elapsed: this.shellPlayer.position
                    }
                }
                updateState()
                this.shellPlayerQueryIntervalId = setInterval(updateState, 1000)
            } else {
                clearInterval(this.shellPlayerQueryIntervalId)
                if (status == PlayerStatus.STOPPED) {
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

    getWebsite() {
        if (!this.currentEpisodeFeedUrl) {
            return
        }
        const episode = this.storage.getEpisode(this.currentEpisodeFeedUrl, this.currentEpisodeGuid!)
        if (!episode.local!.homepageUrl) {
            return
        }
        return episode.local!.homepageUrl
    }

    async openWebsite() {
        if (!this.currentEpisodeFeedUrl) {
            window.showInformationMessage('No episode playing')
            return
        }
        const url = this.getWebsite()
        if (!url) {
            window.showInformationMessage('No episode homepage')
            return
        }
        await env.openExternal(Uri.parse(url))
    }

    cancelDownload() {
        if (this.state.status !== PlayerStatus.DOWNLOADING) {
            window.showInformationMessage('No download in progress')
            return
        }
        this.downloadCancellationTokenSource!.cancel()
    }

    async play(feedUrl: string, guid: string, startPosition: number | undefined=undefined) {
        if (this.state.status === PlayerStatus.DOWNLOADING) {
            window.showWarningMessage('Cannot download multiple episodes in parallel')
            return
        } else if (this.downloadCancellationTokenSource) {
            this.downloadCancellationTokenSource.dispose()
        }
        this.currentEpisodeFeedUrl = feedUrl
        this.currentEpisodeGuid = guid
        this.downloadCancellationTokenSource = new CancellationTokenSource()
        const token = this.downloadCancellationTokenSource.token
        
        try {
            this.state = { status: PlayerStatus.DOWNLOADING }
            const enclosurePath = await this.storage.fetchEpisodeEnclosure(feedUrl, guid,
                progress => {
                    this.state = {
                        status: PlayerStatus.DOWNLOADING,
                        downloadProgress: progress
                    }
                },
                token
            )

            this.state = { status: PlayerStatus.OPENING }

            if (startPosition === undefined) {
                startPosition = this.storage.getLastListeningPosition(feedUrl, guid)
                if (startPosition > 0 && !this.shellPlayer.supportsStartOffset()) {
                    startPosition = 0
                    window.showWarningMessage(`Playing from beginning, player does not support arbitrary positions`)
                }
            }

            const duration = this.storage.getEpisodeDuration(feedUrl, guid)
            
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
            this.state = { status: PlayerStatus.STOPPED }
        }
    }

    stop() {
        this.shellPlayer.stop()
    }

    async restart() {
        if (!this.currentEpisodeFeedUrl) {
            window.showWarningMessage('No episode is playing')
            return
        }
        this.stop()
        const startPosition = 0
        await this.play(this.currentEpisodeFeedUrl, this.currentEpisodeGuid!, startPosition)
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