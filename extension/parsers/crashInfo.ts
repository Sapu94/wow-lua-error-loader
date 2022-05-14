import {readFile} from "fs/promises";

interface LocalVar {
    val: unknown;
    type: string;
}

export interface LocalVars {
    [name: string]: LocalVar;
}

interface FrameInfo {
    name?: string;
    source?: string;
    currentline?: number;
    func?: string;
    locals: LocalVars;
}

export interface CrashInfo {
    // The error message
    errMsg: string;
    // The stack frames
    frames: FrameInfo[];
    // Any log lines which should be displayed in the debug console
    logLines: string[];
}

export interface LineInfo {
    content: string;
    children: LineInfo[];
    parent?: LineInfo;
}

export abstract class CrashFileParser {
    private readonly filePath: string;

    public constructor(filePath: string) {
        this.filePath = filePath;
    }

    public async parse(): Promise<CrashInfo> {
        const lines = (await readFile(this.filePath, {encoding: "utf8"}))
            .replace(/\r\n/g, "\n")
            .split("\n")
            .filter(val => val !== "");
        const tree = this.createTree(lines);
        return this.getCrashInfo(tree);
    }

    protected abstract createTree(lines: string[]): LineInfo;

    protected abstract getCrashInfo(tree: LineInfo): CrashInfo;
}
