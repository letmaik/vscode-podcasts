import { ShellPlayer } from "./shellPlayer";
import { Storage } from "./storage";

interface PodcastEpisode {
    title: string
    description: string
    url: string
    guid?: string
}

export class Player {

    private currentEpisode?: PodcastEpisode

    constructor(private shellPlayer: ShellPlayer, private storage: Storage, private log: (msg: string) => void) {

    }

    async open(episode: PodcastEpisode) {
        this.currentEpisode = episode
    }

}