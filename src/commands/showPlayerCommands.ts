import { window, QuickPickItem, commands } from "vscode";
import { COMMANDS } from "../constants";
import { Command } from "./command";
import { Player } from "../player";
import { ShellPlayer, ShellPlayerCommand } from "../shellPlayer";
import { PlayerStatus } from "../types";

interface CommandItem extends QuickPickItem {
    cmd: string
    cmdArg?: any
}

export class ShowPlayerCommandsCommand implements Command {
    COMMAND = COMMANDS.SHOW_PLAYER_COMMANDS

    constructor(private player: Player, private shellPlayer: ShellPlayer,
                private log: (msg: string) => void) {
    }

    async run() {
        const items: CommandItem[] = []
        const status = this.player.status
        const supportsCmds = this.shellPlayer.supportsCommands()
        // NOTE: When changing conditions, also change in package.json.
        if (status === PlayerStatus.DOWNLOADING) {
            items.push({
                cmd: COMMANDS.CANCEL_DOWNLOAD,
                label: 'Cancel download'
            })
        }
        if (status !== PlayerStatus.STOPPED) {
            const feedUrl = this.player.getFeedUrl()
            items.push({
                cmd: COMMANDS.SHOW_PODCAST,
                cmdArg: feedUrl,
                label: 'Show podcast episodes'
            })
            const website = this.player.getWebsite()
            if (website) {
                items.push({
                    cmd: COMMANDS.OPEN_WEBSITE,
                    label: 'Open episode website',
                    description: website
                })
            }
        }
        if (status === PlayerStatus.PLAYING || status === PlayerStatus.PAUSED) {
            if (supportsCmds) {
                items.push({
                    cmd: COMMANDS.PAUSE,
                    label: status === PlayerStatus.PLAYING ? 'Pause' : 'Unpause'
                })
            }
            items.push({
                cmd: COMMANDS.STOP,
                label: 'Stop'
            })
            items.push({
                cmd: COMMANDS.RESTART,
                label: 'Restart'
            })
        }
        if (status === PlayerStatus.PLAYING) {
            if (supportsCmds) {
                const skipBwdSecs = this.shellPlayer.getCommandInfo(ShellPlayerCommand.SKIP_BACKWARD)
                const skipFwdSecs = this.shellPlayer.getCommandInfo(ShellPlayerCommand.SKIP_FORWARD)
                const slowdownRatio = this.shellPlayer.getCommandInfo(ShellPlayerCommand.SLOWDOWN)
                const speedupRatio = this.shellPlayer.getCommandInfo(ShellPlayerCommand.SPEEDUP)
                items.push(...[{
                    cmd: COMMANDS.SKIP_BACKWARD,
                    label: 'Skip backward',
                    description: `${skipBwdSecs}s`
                }, {
                    cmd: COMMANDS.SKIP_FORWARD,
                    label: 'Skip forward',
                    description: `+${skipFwdSecs}s`
                }, {
                    cmd: COMMANDS.SLOWDOWN,
                    label: 'Slow down',
                    description: `${Math.round(slowdownRatio*100)}%`
                }, {
                    cmd: COMMANDS.SPEEDUP,
                    label: 'Speed up',
                    description: `+${Math.round(speedupRatio*100)}%`
                }])
            }
        }
        const pick = await window.showQuickPick(items, {
            placeHolder: 'Choose an action'
        })
        if (!pick) {
            return
        }
        commands.executeCommand(pick.cmd, pick.cmdArg)
    }
}