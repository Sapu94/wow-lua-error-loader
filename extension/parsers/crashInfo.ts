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

export abstract class CrashFileParser {
    protected filePath: string;

    public constructor(filePath: string) {
        this.filePath = filePath;
    }

    public abstract parse(): CrashInfo;
}
