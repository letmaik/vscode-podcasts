export const NAMESPACE = 'podcasts'
export const LISTEN_API_KEY = '5a7ea0d27548419ca2c9b02e1f526649'

const cmd = (name: string) => `${NAMESPACE}.${name}`

export const COMMANDS = {
    SHOW_PODCAST: cmd('showPodcast'),
    SEARCH_PODCASTS: cmd('searchPodcasts'),
    SEARCH_EPISODES: cmd('searchEpisodes'),
    ADD_BY_FEED_URL: cmd('addByFeedUrl'),
    IMPORT_FROM_OPML: cmd('importFromOPML'),
    EXPORT_AS_OPML: cmd('exportAsOPML'),
    SHOW_PLAYER_COMMANDS: cmd('showPlayerCommands'),
    SHOW_STARRED_PODCASTS: cmd('showStarredPodcasts'),
    SHOW_HISTORY: cmd('showHistory'),

    // player commands (without UI)
    OPEN_WEBSITE: cmd('openWebsite'),
    CANCEL_DOWNLOAD: cmd('cancelDownload'),
    PAUSE: cmd('pause'),
    STOP: cmd('stop'),
    RESTART: cmd('restart'),
    SKIP_BACKWARD: cmd('skipBackward'),
    SKIP_FORWARD: cmd('skipForward'),
    SLOWDOWN: cmd('slowdown'),
    SPEEDUP: cmd('speedup'),
}