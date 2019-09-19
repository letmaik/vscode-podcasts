import { window } from "vscode";
import { Command } from "./command";
import { Player } from "../player";

export class PlayerCommand implements Command {
    constructor(public COMMAND: string, private player: Player,
                private fn: (player: Player) => Promise<void>,
                private log: (msg: string) => void) {
    }

    async run() {
        try {
            await this.fn(this.player)
        } catch (e) {
            console.error(e)
            window.showErrorMessage(e.message)
        }
    }
}