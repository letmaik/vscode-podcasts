import { window, QuickPickItem, commands } from "vscode";
import { COMMANDS } from "../constants";
import { Command } from "./command";

interface CommandItem extends QuickPickItem {
    cmd: string
    cmdArg?: any
}

export class ShowMainCommandsCommand implements Command {
    COMMAND = COMMANDS.SHOW_MAIN_COMMANDS

    constructor(private log: (msg: string) => void) {
    }

    async run() {
        const items: CommandItem[] = []
        
        items.push(...[{
            cmd: COMMANDS.SHOW_STARRED_PODCASTS,
            label: 'Show starred podcasts'
        }, {
            cmd: COMMANDS.SHOW_HISTORY,
            label: 'Show listening history'
        }, {
            cmd: COMMANDS.SEARCH_EPISODES,
            label: 'Search episodes using Listen Notes'
        }, {
            cmd: COMMANDS.SEARCH_PODCASTS,
            label: 'Search podcasts using Listen Notes'
        },{
            cmd: COMMANDS.ADD_BY_FEED_URL,
            label: 'Add starred podcast by feed URL'
        }])
       
        const pick = await window.showQuickPick(items, {
            placeHolder: 'Choose an action'
        })
        if (!pick) {
            return
        }
        commands.executeCommand(pick.cmd, pick.cmdArg)
    }
}