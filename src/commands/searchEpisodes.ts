import { ListenNotesEpisodeSearchQuickPick } from "../quickpicks/listenNotesSearch";
import { Configuration, SearchConfiguration } from "../types";
import { ListenNotes } from "../listenNotes";
import { COMMANDS } from "../constants";
import { Command } from "./command";
import { Storage } from "../storage";
import { Player } from "../player";
import { window } from "vscode";

export class SearchEpisodesCommand implements Command {
    COMMAND = COMMANDS.SEARCH_EPISODES

    constructor(private searchCfg: SearchConfiguration, private listenNotes: ListenNotes,
                private storage: Storage, private player: Player,
                private log: (msg: string) => void) {
    }

    updateSearchConfiguration(searchCfg: SearchConfiguration) {
        this.searchCfg = searchCfg
    }

    async run(query?: string) {
        const pick = new ListenNotesEpisodeSearchQuickPick(this.searchCfg, this.listenNotes, query, this.log)
        const episode = await pick.show()
        if (!episode) {
            return
        }
        const realFeedUrl = await this.listenNotes.resolveRedirect(episode.feedUrl)
        const podcast = await this.storage.fetchPodcast(realFeedUrl, episode.published)
        let match = Object.entries(podcast.local!.episodes).find(
            ([_, ep]) => ep.title === episode.title)
        if (!match) {
            this.log(`Unable to match "${episode.title}" to an episode in ${realFeedUrl}, trying enclosure URL`)
            
            const realEnclosureUrl = await this.listenNotes.resolveRedirect(episode.enclosureUrl)
            match = Object.entries(podcast.local!.episodes).find(
                ([_, ep]) => ep.enclosureUrl === realEnclosureUrl)
            if (!match) {
                this.log(`Unable to match ${realEnclosureUrl} to an episode in ${realFeedUrl}`)
                this.log(`Listen Notes feed: ${episode.feedUrl}`)
                this.log(`Listen Notes audio: ${episode.enclosureUrl}`)
                window.showErrorMessage(`Unexpected error, please report an issue ` +
                    `(see View -> Output for error details)`)
                return
            }
        }
        const [realGuid, _] = match
        await this.player.play(realFeedUrl, realGuid)
    }
}