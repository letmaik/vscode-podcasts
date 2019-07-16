import { window, QuickPickItem, QuickPick } from "vscode";
import { SearchResult, PodcastResult, ListenNotes } from "../listenNotes";
import { toHumanTimeAgo } from "../util";
import { PodcastItem, EpisodeItem, SearchConfiguration } from "../types";
import { debounce } from "../3rdparty/git/decorators";

class LoadMoreItem implements QuickPickItem {
    label = 'Load more...'
    alwaysShow = true
}

type PodcastSearchItem = PodcastItem | LoadMoreItem
type EpisodeSearchItem = EpisodeItem | LoadMoreItem

export class ListenNotesPodcastSearchQuickPick {
    private quickpick: QuickPick<PodcastSearchItem>
    private currentOffset = 0
    private nextOffset: number
    private results: PodcastResult[]

    constructor(private cfg: SearchConfiguration, private listenNotes: ListenNotes,
        private log: (msg: string) => void) {
    }

    @debounce(500)
    async searchAndUpdateItems(query: string) {
        // Currently we only want to support sorting episodes by date.
        const opts = Object.assign({offset: this.currentOffset}, this.cfg);
        opts.sortByDate = false

        let data: SearchResult<PodcastResult>
        try {
            data = await this.listenNotes.searchPodcasts(query, opts)
        } catch (e) {
            console.error(e)
            window.showErrorMessage(e.message)
            return
        } finally {
            this.quickpick.busy = false
        }

        const items: PodcastSearchItem[] = data.results.map(podcast => ({
            label: podcast.title_original,
            description: `Last episode: ` + toHumanTimeAgo(podcast.latest_pub_date_ms),
            detail: podcast.description_original,
            url: podcast.rss,
            alwaysShow: true            
        }))
        
        // TODO items are sorted by vs code based on filter string
        //   -> impossible to append (new) items at the end
        //if (data.next_offset < data.total) {
        //    items.push(new LoadMoreItem())
        //}
        
        for (const i of items) {
            this.log(`${i.label}`)
        }
        this.quickpick.items = items
    }

    async show() {
        const pick = window.createQuickPick<PodcastSearchItem>()
        this.quickpick = pick
        pick.title = 'Search podcasts using Listen Notes'
        pick.ignoreFocusOut = true
        pick.placeholder = 'Enter a search term'

        pick.onDidChangeValue(query => {
            pick.items = []
            if (!query) {
                return
            }
            pick.busy = true
            this.searchAndUpdateItems(query)
        })

        const pickerPromise = new Promise<PodcastItem | undefined>((resolve, _) => {
            pick.onDidAccept(() => {
                const items = pick.selectedItems
                if (items.length > 0) {
                    const item = pick.selectedItems[0]
                    if (item instanceof LoadMoreItem) {
                        // TODO load more and concat with existing results
                    } else {
                        resolve(item)
                        pick.dispose()
                    }
                }
            })
            pick.onDidHide(() => {
                resolve(undefined)
                pick.dispose()
            })
        })
        pick.show()
        const item = await pickerPromise
        if (item) {
            return item.url
        }
    }
}