import { StatusBarItem, window, StatusBarAlignment, Disposable } from "vscode";
import { NAMESPACE } from "./constants";
import { toHumanDuration } from "./util";

export enum StatusBarStatus {
    DOWNLOADING,
    OPENING,
    PLAYING,
    PAUSED,
    STOPPED
}

export interface StatusBarState {
    status: StatusBarStatus,
    downloadProgress?: number,
    duration?: number,
    elapsed?: number
}

export class StatusBar {
    private readonly textPrefix = '$(radio-tower) '
    private readonly cmd = NAMESPACE + '.main'

    private statusBarItem: StatusBarItem
    private state: StatusBarState = {
        status: StatusBarStatus.STOPPED
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

    update(state: StatusBarState) {
        if (this.state.status === StatusBarStatus.STOPPED && state.status !== StatusBarStatus.STOPPED) {
            this.statusBarItem.show()
        } else if (this.state.status !== StatusBarStatus.STOPPED && state.status === StatusBarStatus.STOPPED) {
            this.statusBarItem.hide()
        }

        if (state.status === StatusBarStatus.DOWNLOADING) {
            let text = 'Downloading...'
            if (state.downloadProgress) {
                text += `${Math.round(state.downloadProgress*100)}%`
            }
            this.text = text
        } else if (state.status === StatusBarStatus.OPENING) {
            this.text = 'Opening...'
        } else if (state.duration && state.elapsed) {
            const remaining = state.duration - state.elapsed
            this.text = toHumanDuration(remaining) + ' remaining'
        }

        this.state = state
    }
}