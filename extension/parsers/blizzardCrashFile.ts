import {CrashFileParser, CrashInfo, LineInfo} from "./crashInfo";

export class BlizzardCrashFileParser extends CrashFileParser {
    protected createTree(lines: string[]): LineInfo {
        lines = lines.filter(line => line.trim() !== "");
        const rootNode: LineInfo = {content: "", children: []};
        for (const line of lines) {
            const headingMatch = /^([A-Z][A-Za-z ]+): (.+)$/.exec(line);
            if (headingMatch) {
                const [headingType, headingContent] = headingMatch.slice(1);
                const node: LineInfo = {content: "", children: [], parent: rootNode};
                if (headingType === "Message") {
                    node.content = line;
                } else if (headingType === "Time" || headingType === "Count") {
                    // ignore these lines
                    continue;
                } else if (headingType === "Stack") {
                    node.content = "Stack:";
                    const childNode = {content: headingContent, children: [], parent: node};
                    node.children.push(childNode);
                } else if (headingType === "Locals") {
                    node.content = "Locals:";
                    const childNode = {content: headingContent, children: [], parent: node};
                    node.children.push(childNode);
                } else {
                    throw Error(`Invalid crash file heading type: '${headingType}'`);
                }
                rootNode.children.push(node);
            } else {
                if (rootNode.children.length === 0) {
                    throw Error(`Invalid crash file line: '${line}'`);
                }
                const prevNode = rootNode.children[rootNode.children.length - 1];
                const node: LineInfo = {content: line, children: [], parent: prevNode};
                prevNode.children.push(node);
            }
        }
        return rootNode;
    }

    protected getCrashInfo(tree: LineInfo): CrashInfo {
        const crashInfo: CrashInfo = {errMsg: "", frames: [], logLines: []};
        for (const headingNode of tree.children) {
            const headingMatch = /^([A-Za-z ]+): ?(.*)$/.exec(headingNode.content);
            if (!headingMatch) {
                throw Error(`Invalid crash file heading line: '${headingNode.content}'`);
            }
            const [headingType, headingContent] = headingMatch.slice(1);
            if (headingType === "Message") {
                crashInfo.errMsg = headingContent.replace(/^TSM[/\\]/g, "");
            } else if (headingType === "Stack") {
                // Get the path of the addon we're debugging from the first stack frame line
                if (headingNode.children.length === 0) {
                    throw Error("Crash file has an empty stack");
                }
                let firstStackFrame = headingNode.children[0].content;
                const partialPathMatch = /^\.\.\.([^:]+)/.exec(firstStackFrame);
                if (partialPathMatch) {
                    const partialPath = partialPathMatch[1];
                    // Try to find the full path in the rest of the stack frames
                    for (const frameNode of headingNode.children) {
                        const match = /^\[string "@?([^"]+)"\]:?[0-9]*: .+/.exec(frameNode.content);
                        if (match) {
                            const [fullPath] = match.splice(1);
                            if (fullPath.endsWith(partialPath)) {
                                firstStackFrame = firstStackFrame.replace(`...${partialPath}`, fullPath);
                                break;
                            }
                        }
                    }
                }
                const firstStackFrameMatch
                    = /^(Interface[/\\]Add[Oo]ns[/\\][^/\\]+)[/\\]([^.]+\.lua):([0-9]+):/.exec(firstStackFrame);
                if (!firstStackFrameMatch) {
                    throw Error(`Failed to parse first stack frame: ${firstStackFrame}`);
                }
                const [addonPath, firstStackFilePath, firstStackLine] = firstStackFrameMatch.slice(1);
                crashInfo.frames.push({
                    name: "?",
                    source: firstStackFilePath,
                    currentline: this.tonumber(firstStackLine) ?? 0,
                    func: "?",
                    locals: {},
                });

                for (const frameNode of headingNode.children.slice(1)) {
                    if (frameNode.content === "...") {
                        break;
                    }
                    const frameMatch = /^\[string "@?([^"]+)"\]:?([0-9]*): (.+)/.exec(frameNode.content);
                    if (!frameMatch) {
                        throw Error(`UNKNOWN FRAME: ${frameNode.content}`);
                    }
                    const [rawLocation, line, rawName] = frameMatch.slice(1);
                    let location = rawLocation;
                    let name = rawName;
                    if (location.startsWith(addonPath)) {
                        location = location.slice(addonPath.length + 1);
                    }
                    const nameMatch = /in function [`<](.+)['>]/.exec(name);
                    if (nameMatch) {
                        name = nameMatch[1];
                    }
                    crashInfo.frames.push({
                        name,
                        source: location,
                        currentline: this.tonumber(line) ?? 0,
                        func: location,
                        locals: {},
                    });
                }
            } else if (headingType === "Locals") {
                // TODO
            } else {
                throw Error(`Invalid crash file heading: '${headingType}'`);
            }
        }
        return crashInfo;
    }

    private tonumber(str: string): number | null {
        const val = parseFloat(str);
        return isNaN(val) ? null : val;
    }
}
