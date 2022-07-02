import {CrashFileParser, CrashInfo, LineInfo, LocalVars} from "./crashInfo";

const IGNORED_HEADING_SECTIONS = [
    "Time",
    "Client",
    "Locale",
    "Combat",
    "Error Count",
    "Temp Tables",
    "Object Pools",
    "Running Threads",
    "Addons"
];

export class TSMCrashFileParser extends CrashFileParser {
    private inTable(search: string, tbl: string[]): boolean {
        for (const entry of tbl) {
            if (entry === search) {
                return true;
            }
        }
        return false;
    }

    private tonumber(str: string): number | null {
        const val = parseFloat(str);
        return isNaN(val) ? null : val;
    }

    private parseLocalVar(node: LineInfo): {name: string; value: unknown; type: string} | null {
        const nameValueMatch = /(.+) = (.+)/.exec(node.content);
        if (!nameValueMatch) {
            return null;
        }
        const [name, value] = nameValueMatch.slice(1);
        const strValueMatch = /"(.*)"/.exec(value);
        if (strValueMatch) {
            return {name, value: strValueMatch[1], type: "string"};
        } else if (value.substring(0, 10) === "<function>") {
            return {name, value, type: "function"};
        } else if (value.substring(0, 1) === "{") {
            const tblValue: {[key: string | number]: unknown} = {};
            for (const childNode of node.children) {
                const info = this.parseLocalVar(childNode);
                if (info) {
                    tblValue[this.tonumber(info.name) ?? info.name] = info.value;
                }
            }
            return {name, value: tblValue, type: "table"};
        } else if (this.tonumber(value) !== null) {
            return {name, value: this.tonumber(value), type: "number"};
        } else if (value === "nil") {
            return {name, value: null, type: "nil"};
        } else if (value.substring(value.length - 2) === "{}" || value.substring(value.length - 1) === "{") {
            const tblNameMatch = /= <?(.+)>? {/.exec(node.content);
            const type = tblNameMatch ? `table<${tblNameMatch[1]}>` : "table";
            const tblValue: {[key: string | number]: unknown} = {};
            for (const childNode of node.children) {
                const info = this.parseLocalVar(childNode);
                if (info) {
                    tblValue[this.tonumber(info.name) ?? info.name] = info.value;
                }
            }
            return {name, value: tblValue, type};
        } else if (value === "<userdata>") {
            return {name, value, type: "userdata"};
        } else if (value === "true" || value === "false") {
            return {name, value: (value === "true"), type: "boolean"};
        } else if (value === "Infinite") {
            return {name, value: Infinity, type: "number"};
        } else {
            throw Error(`Unknown local: ${node.content}`);
        }
    }

    protected createTree(lines: string[]): LineInfo {
        // Parse the lines into a `LineInfo` tree
        const rootNode: LineInfo = {content: "", children: []};
        let currentNode: LineInfo = rootNode;
        let currentLevel = 0;
        for (const line of lines) {
            const lineMatch = /^( *)(.+)/.exec(line);
            if (!lineMatch) {
                throw Error(`Invalid crash file line: '${line}'`);
            }
            const [spaces, content] = lineMatch.slice(1);
            if ((spaces.length % 2) !== 0) {
                throw Error(`Invalid crash file line indentation: ${spaces.length} spaces`);
            }
            const level = spaces.length / 2;
            const node: LineInfo = {content, children: []};
            if (level === 0) {
                // Top-level node
                node.parent = rootNode;
            } else if (level === currentLevel) {
                // Sibling node
                node.parent = currentNode.parent;
            } else if (level === currentLevel + 1) {
                // Child node
                node.parent = currentNode;
            } else if (level < currentLevel) {
                // Walk back up the tree
                while (level < currentLevel) {
                    currentLevel--;
                    if (!currentNode.parent) {
                        throw Error();
                    }
                    currentNode = currentNode.parent;
                }
                node.parent = currentNode.parent;
            } else {
                throw Error(`Invalid crash file line: ${line}`);
            }
            if (!node.parent) {
                throw Error();
            }
            node.parent.children.push(node);
            currentNode = node;
            currentLevel = level;
        }
        return rootNode;
    }

    protected getCrashInfo(tree: LineInfo): CrashInfo {
        // Walk through the tree and pull out the relavent info
        const crashInfo: CrashInfo = {errMsg: "", frames: [], logLines: []};
        for (const headingNode of tree.children) {
            const headingMatch = /^([A-Za-z ]+): ?(.*)$/.exec(headingNode.content);
            if (!headingMatch) {
                throw Error(`Invalid crash file heading line: '${headingNode.content}'`);
            }
            const [headingType, headingContent] = headingMatch.slice(1);
            if (headingType === "Message") {
                crashInfo.errMsg = headingContent.replace(/^TSM[/\\]/g, "");
            } else if (headingType === "Stack Trace") {
                for (const frameNode of headingNode.children) {
                    const frameMatch = /^(.+) <(.+)>$/.exec(frameNode.content);
                    if (!frameMatch) {
                        throw Error(`Invalid frame line: ${frameNode.content}`);
                    }
                    const [location, name] = frameMatch.slice(1);
                    const locationMatch = /^TSM[/\\](.+):([0-9]+)/.exec(location);
                    const [file, line] = locationMatch ? locationMatch.slice(1) : [null, null];
                    const locals: LocalVars = {};
                    for (const localNode of frameNode.children) {
                        const localInfo = this.parseLocalVar(localNode);
                        if (localInfo) {
                            locals[localInfo.name] = {
                                val: localInfo.value,
                                type: localInfo.type,
                            };
                        }
                    }
                    crashInfo.frames.push({
                        name,
                        source: file ?? "",
                        currentline: line !== null ? (this.tonumber(line) ?? 0) : 0,
                        func: location,
                        locals
                    });
                }
            } else if (headingType === "Debug Log") {
                crashInfo.logLines = headingNode.children.reverse()
                    .map(node => node.content);
            } else if (this.inTable(headingType, IGNORED_HEADING_SECTIONS)) {
                // ignore this section
            } else {
                throw Error(`Invalid crash file line: '${headingNode.content}'`);
            }
        }

        if (crashInfo.errMsg === "") {
            throw Error("Could not find error message in crash file");
        } else if (crashInfo.frames.length === 0) {
            throw Error("Could not find frames in crash file");
        }
        return crashInfo;
    }
}
