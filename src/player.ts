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

    async openWebsite() {
        if (!this.currentEpisodeFeedUrl) {
            window.showInformationMessage('No episode playing')
            return
        }
        const episode = this.storage.getEpisode(this.currentEpisodeFeedUrl, this.currentEpisodeGuid!)
        if (!episode.homepageUrl) {
            window.showInformationMessage('No episode homepage')
            return
        }
        env.openExternal(Uri.parse(episode.homepageUrl))
    }

    cancelDownload() {
        if (this.state.status !== PlayerStatus.DOWNLOADING) {
            window.showInformationMessage('No download in progress')
            return
        }
        this.downloadCancellationTokenSource!.cancel()
    }

    async play(feedUrl: string, guid: string) {
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

            let startPosition = this.storage.getLastListeningPosition(feedUrl, guid)
            if (startPosition > 0 && !this.shellPlayer.supportsStartOffset()) {
                startPosition = 0
                window.showWarningMessage(`Playing from beginning, player does not support arbitrary positions`)
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