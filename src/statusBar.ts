import { StatusBarItem, window, StatusBarAlignment, Disposable } from "vscode";
import { NAMESPACE } from "./constants";
import { toHumanDuration } from "./util";
import { PlayerStatus, PlayerState } from "./types";

export class StatusBar {
    private readonly textPrefix = '$(radio-tower) '
    private readonly cmd = NAMESPACE + '.showPlayerCommands'

    private statusBarItem: StatusBarItem
    private state: PlayerState = {
        status: PlayerStatus.STOPPED
    }

    constructor(private disposables: Disposable[]) {
        const statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 100)
        this.statusBarItem = statusBarItem
        this.statusBarItem.command = this.cmd
        this.disposables.push(statusBarItem)
    }

    private set text(v: string) {
        this.statusBarItem.text = this.textPrefix + v
    }

    update(state: PlayerState) {
        if (this.state.status === PlayerStatus.STOPPED && state.status !== PlayerStatus.STOPPED) {
            this.statusBarItem.show()
        } else if (this.state.status !== PlayerStatus.STOPPED && state.status === PlayerStatus.STOPPED) {
            this.statusBarItem.hide()
        }

        if (state.status === PlayerStatus.DOWNLOADING) {
            let text = 'Downloading...'
            if (state.downloadProgress) {
                text += `${Math.round(state.downloadProgress*100)}%`
            }
            this.text = text
        } else if (state.status === PlayerStatus.OPENING) {
            this.text = 'Opening...'
        } else if (state.duration && state.elapsed) {
            const remaining = state.duration - state.elapsed
            this.text = toHumanDuration(remaining) + ' remaining'
        }

        this.state = state
    }
}