import { ExtensionContext, Uri } from "vscode";

export class Resources {
    constructor(private context: ExtensionContext) {
    }

    getIconPath(name: string): { light: Uri; dark: Uri } {
        return {
            light: Uri.file(this.context.asAbsolutePath(`resources/icons/light/${name}.svg`)),
            dark: Uri.file(this.context.asAbsolutePath(`resources/icons/dark/${name}.svg`))
        }
    }
}