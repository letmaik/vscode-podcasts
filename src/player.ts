import { ShellPlayer } from "./shellPlayer";

interface PodcastEpisode {
    title: string
    description: string
    url: string
    guid?: string
}

export class Player {

    private currentEpisode?: PodcastEpisode

    constructor(private shellPlayer: ShellPlayer, private log: (msg: string) => void) {

    }

    open(episode: PodcastEpisode) {
        this.currentEpisode = episode
    }

}