import { ListenNotesPodcastSearchQuickPick } from "../quickpicks/listenNotesSearch";
import { Configuration, SearchConfiguration } from "../types";
import { ListenNotes } from "../listenNotes";
import { commands } from "vscode";
import { COMMANDS } from "../constants";
import { Command } from "./command";

export class SearchPodcastsCommand implements Command {
    COMMAND = COMMANDS.SEARCH_PODCASTS

    constructor(private searchCfg: SearchConfiguration, private listenNotes: ListenNotes, private log: (msg: string) => void) {
    }

    updateSearchConfiguration(searchCfg: SearchConfiguration) {
        this.searchCfg = searchCfg
    }

    async run(query?: string) {
        const pick = new ListenNotesPodcastSearchQuickPick(this.searchCfg, this.listenNotes, query, this.log)
        const url = await pick.show()
        if (!url) {
            return
        }
        const resolveListenNotes = true
        commands.executeCommand(COMMANDS.SHOW_PODCAST, url, resolveListenNotes, this.COMMAND, pick.lastQuery)
    }
}