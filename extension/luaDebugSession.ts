import {DebugProtocol} from "vscode-debugprotocol";
import {
    InitializedEvent,
    LoggingDebugSession,
    Scope,
    StackFrame,
    Source,
    OutputEvent,
    TerminatedEvent,
    StoppedEvent,
    Variable,
    Handles,
} from "vscode-debugadapter";
import * as path from "path";
import * as fs from "fs";
import {LaunchConfig} from "./launchConfig";
import {CrashFileParser, CrashInfo} from "./parsers/crashInfo";
import {TSMCrashFileParser} from "./parsers/tsmCrashFile";

const enum ScopeType {
    Local = 1,
}

const enum OutputCategory {
    StdOut = "stdout",
    StdErr = "stderr",
    Command = "command",
    Request = "request",
    // eslint-disable-next-line @typescript-eslint/no-shadow
    Message = "message",
    Info = "info",
    Error = "error",
    Log = "log",
}

const maxStackCount = 100;

function sortVariables(a: Variable, b: Variable): number {
    const aIsBracketted = a.name.startsWith("[[");
    const bIsBracketted = b.name.startsWith("[[");
    if (aIsBracketted !== bIsBracketted) {
        return aIsBracketted ? -1 : 1;
    }

    const aAsNum = Number(a.name);
    const bAsNum = Number(b.name);
    const aIsNum = !isNaN(aAsNum);
    const bIsNum = !isNaN(bAsNum);
    if (aIsNum !== bIsNum) {
        return aIsNum ? -1 : 1;
    } else if (aIsNum && bIsNum) {
        return aAsNum - bAsNum;
    }

    let aName = a.name.replace("[", " ");
    let bName = b.name.replace("[", " ");

    const aNameLower = aName.toLowerCase();
    const bNameLower = bName.toLowerCase();
    if (aNameLower !== bNameLower) {
        aName = aNameLower;
        bName = bNameLower;
    }

    if (aName === bName) {
        return 0;
    } else if (aName < bName) {
        return -1;
    } else {
        return 1;
    }
}

export class LuaDebugSession extends LoggingDebugSession {
    private config?: LaunchConfig;
    private onConfigurationDone?: () => void;
    private readonly variableHandles = new Handles<string>(ScopeType.Local + 1);
    private crashInfo?: CrashInfo;
    private frame: number = 0;

    public constructor() {
        super("wow-lua-error-loader-log.txt");
    }

    protected initializeRequest(
        resp: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments
    ): void {
        this.showOutput("initializeRequest", OutputCategory.Request);

        if (typeof resp.body === "undefined") {
            resp.body = {};
        }

        resp.body.supportsConfigurationDoneRequest = true;
        resp.body.supportsTerminateRequest = true;

        this.sendResponse(resp);

        this.sendEvent(new InitializedEvent());
    }

    protected configurationDoneRequest(
        resp: DebugProtocol.ConfigurationDoneResponse,
        args: DebugProtocol.ConfigurationDoneArguments
    ): void {
        this.showOutput("configurationDoneRequest", OutputCategory.Request);

        super.configurationDoneRequest(resp, args);

        if (typeof this.onConfigurationDone !== "undefined") {
            this.onConfigurationDone();
        }
    }

    protected async launchRequest(
        resp: DebugProtocol.LaunchResponse,
        args: DebugProtocol.LaunchRequestArguments & LaunchConfig
    ): Promise<void> {
        this.config = args;
        this.showOutput("launchRequest", OutputCategory.Request);
        await this.waitForConfiguration();

        // Load the crash file
        if (!path.isAbsolute(this.config.cwd)) {
            this.config.cwd = path.resolve(this.config.workspacePath, this.config.cwd);
        }
        const crashFilePath = this.config.cwd + path.sep + this.config.crashFile;
        this.showOutput(`loading "${crashFilePath}"`, OutputCategory.Info);

        // Parse the crash file
        // TODO: add support for other parsers here in the future
        let fileParser: CrashFileParser;
        // eslint-disable-next-line
        if (true) {
            fileParser = new TSMCrashFileParser(crashFilePath);
        }
        this.crashInfo = fileParser.parse();

        // Stop execution with the error from the crash file
        this.showOutput(this.crashInfo.errMsg, OutputCategory.Error);
        const evt: DebugProtocol.StoppedEvent = new StoppedEvent("exception", 1, this.crashInfo.errMsg);
        evt.body.allThreadsStopped = true;
        this.sendEvent(evt);

        // Print out any log lines
        for (const line of this.crashInfo.logLines) {
            this.showOutput(line, OutputCategory.Log);
        }

        this.sendResponse(resp);
    }

    protected threadsRequest(resp: DebugProtocol.ThreadsResponse): void {
        this.showOutput("threadsRequest", OutputCategory.Request);
        // Just the main thread
        resp.body = {
            threads: [
                {
                    id: 1,
                    name: "main thread"
                }
            ],
        };
        this.sendResponse(resp);
    }

    protected stackTraceRequest(resp: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
        this.showOutput(
            `stackTraceRequest ${args.startFrame}/${args.levels} (thread ${args.threadId})`,
            OutputCategory.Request
        );

        if (!this.crashInfo) {
            resp.success = false;
            this.sendResponse(resp);
            return;
        }

        const startFrame = typeof args.startFrame !== "undefined" ? args.startFrame : 0;
        const maxLevels = typeof args.levels !== "undefined" ? args.levels : maxStackCount;
        const endFrame = Math.min(startFrame + maxLevels, this.crashInfo.frames.length);
        const frames: DebugProtocol.StackFrame[] = [];
        for (let i = startFrame; i < endFrame; ++i) {
            const info = this.crashInfo.frames[i];
            const currentLine = info.currentline;

            let source: Source | undefined;
            const column = 1; //Needed for exception display: https://github.com/microsoft/vscode/issues/46080

            //Un-mapped source
            let sourceStr = "";
            if (typeof info.source !== "undefined") {
                sourceStr = info.source.replace(/[/\\]+/g, path.sep);
            }
            const sourcePath = this.resolvePath(sourceStr);
            if (typeof source === "undefined" && typeof sourcePath !== "undefined") {
                source = new Source(path.basename(sourceStr), sourcePath);
            }

            //Function name
            const func = info.name ?? info.func;
            let frameFunc = typeof func !== "undefined" ? func : "???";
            if (typeof sourcePath === "undefined") {
                frameFunc += ` ${sourceStr}`;
            }

            const frameId = i;
            let line = -1;
            if (typeof currentLine !== "undefined" && currentLine > 0) {
                line = currentLine;
            }
            const stackFrame: DebugProtocol.StackFrame = new StackFrame(frameId, frameFunc, source, line, column);
            stackFrame.presentationHint = typeof sourcePath === "undefined" ? "subtle" : "normal";
            frames.push(stackFrame);
        }
        resp.body = {stackFrames: frames, totalFrames: this.crashInfo.frames.length};
        this.sendResponse(resp);
    }

    protected scopesRequest(resp: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        this.showOutput("scopesRequest", OutputCategory.Request);
        this.frame = args.frameId;
        const scopes: Scope[] = [
            new Scope("Locals", ScopeType.Local, false)
        ];
        resp.body = {scopes};
        this.sendResponse(resp);
    }

    protected variablesRequest(resp: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
        if (!this.crashInfo) {
            resp.success = false;
            this.sendResponse(resp);
            return;
        }

        const variables: Variable[] = [];
        if (args.variablesReference === ScopeType.Local) {
            this.showOutput("variablesRequest locals", OutputCategory.Request);
            const locals = this.crashInfo.frames[this.frame].locals;
            for (const luaName in locals) {
                const value = locals[luaName];
                let valueStr: string;
                let indexedVariables: number | undefined;
                if (value.type === "string") {
                    valueStr = `"${value.val}"`;
                } else if (value.type === "number" || value.type === "boolean") {
                    valueStr = `${value.val}`;
                } else if (value.type === "nil") {
                    valueStr = "nil";
                } else if (value.type === "table") {
                    valueStr = "<table>";
                    indexedVariables = 0;
                    while (true) {
                        if (`${indexedVariables + 1}` in (value.val as Record<string, unknown>)) {
                            indexedVariables++;
                        } else {
                            break;
                        }
                    }
                    indexedVariables = indexedVariables > 0 ? indexedVariables + 1 : indexedVariables;
                } else if (value.type === "function") {
                    valueStr = "<function>";
                } else {
                    valueStr = `[${value.type}]`;
                }

                if (value.type === "table") {
                    const ref = this.variableHandles.create(`${this.frame}:${luaName}`);
                    variables.push(new Variable(luaName, valueStr, ref, indexedVariables, 1));
                } else {
                    let newRef: undefined;
                    variables.push(new Variable(luaName, valueStr, newRef, 0));
                }
            }
        } else {
            const ref = this.variableHandles.get(args.variablesReference);
            this.showOutput(
                `variablesRequest ${ref} ${args.filter} ${args.start}/${args.count}`,
                OutputCategory.Request
            );
            const parts = ref.split(":");
            if (parts.length < 2) {
                throw Error("Invalid ref");
            }
            const locals = this.crashInfo.frames[parseInt(parts[0])].locals;
            let tblVar = locals[parts[1]].val as Record<string, unknown>;
            for (let i = 2; i < parts.length; i++) {
                tblVar = tblVar[parts[i]] as Record<string, unknown>;
            }
            if (args.filter === "named") {
                for (const key in tblVar) {
                    if (Number.isInteger(Number(key))) {
                        // TODO: support non-index, numeric keys
                        continue;
                    }
                    variables.push(this.handleVariable(tblVar[key], key, ref));
                }
            } else if (args.filter === "indexed") {
                if (typeof args.start === "undefined" || typeof args.count === "undefined") {
                    throw Error("Unhandled request");
                }
                const first = Math.max(args.start, 1);
                const last = args.start + args.count - 1;
                for (let i = first; i <= last; i++) {
                    variables.push(this.handleVariable(tblVar[i], `${i}`, ref));
                }
            } else if (typeof args.filter === "undefined") {
                for (const key in tblVar) {
                    variables.push(this.handleVariable(tblVar[key], key, ref));
                }
            } else {
                throw new Error(`Unexpected filter: ${args.filter}`);
            }
        }
        variables.sort(sortVariables);
        resp.body = {variables};
        this.sendResponse(resp);
    }

    protected continueRequest(resp: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        this.showOutput("continueRequest", OutputCategory.Request);
        this.variableHandles.reset();
        this.sendResponse(resp);
        this.sendEvent(new TerminatedEvent());
    }


    protected nextRequest(resp: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        this.showOutput("nextRequest", OutputCategory.Request);
        this.variableHandles.reset();
        this.sendResponse(resp);
        this.sendEvent(new TerminatedEvent());
    }

    protected stepInRequest(resp: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
        this.showOutput("stepInRequest", OutputCategory.Request);
        this.variableHandles.reset();
        this.sendResponse(resp);
        this.sendEvent(new TerminatedEvent());
    }

    protected stepOutRequest(resp: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
        this.showOutput("stepOutRequest", OutputCategory.Request);
        this.variableHandles.reset();
        this.sendResponse(resp);
        this.sendEvent(new TerminatedEvent());
    }

    protected terminateRequest(
        resp: DebugProtocol.TerminateResponse,
        args: DebugProtocol.TerminateArguments
    ): void {
        this.showOutput("terminateRequest", OutputCategory.Request);
        this.sendResponse(resp);
        this.sendEvent(new TerminatedEvent());
    }

    private handleVariable(value: unknown, key: string, ref: string): Variable {
        let valueStr: string;
        let indexedVariables: number | undefined;
        if (typeof value === "string") {
            valueStr = `"${value}"`;
        } else if (typeof value === "number" || typeof value === "boolean") {
            valueStr = `${value}`;
        } else if (typeof value === "undefined") {
            valueStr = "nil";
        } else if (typeof value === "object") {
            valueStr = "<table>";
            indexedVariables = 0;
            while (true) {
                if (`${indexedVariables + 1}` in (value as Record<string, unknown>)) {
                    indexedVariables++;
                } else {
                    break;
                }
            }
            indexedVariables = indexedVariables > 0 ? indexedVariables + 1 : indexedVariables;
        } else {
            valueStr = `[${typeof value}]`;
        }
        if (typeof value === "object") {
            const newRef = this.variableHandles.create(`${ref}:${key}`);
            return new Variable(key, valueStr, newRef, indexedVariables, 1);
        } else {
            let newRef: undefined;
            return new Variable(key, valueStr, newRef, 0);
        }
    }

    private assert<T>(value: T | null | undefined, message = "assertion failed"): T {
        if (value === null || typeof value === "undefined") {
            this.sendEvent(new OutputEvent(message));
            throw new Error(message);
        }
        return value;
    }

    private resolvePath(filePath: string) {
        if (filePath.length === 0) {
            return;
        }
        const config = this.assert(this.config);
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(config.cwd, filePath);
        if (fs.existsSync(fullPath)) {
            return fullPath;
        }
    }

    private showOutput(msg: string, category: OutputCategory) {
        if (msg.length === 0) {
            return;

        } else if (category === OutputCategory.StdOut || category === OutputCategory.StdErr) {
            this.sendEvent(new OutputEvent(msg, category));

        } else if (category === OutputCategory.Log) {
            this.sendEvent(new OutputEvent(`[${category}] ${msg}\n`, "stdout"));

        } else if (category === OutputCategory.Error) {
            this.sendEvent(new OutputEvent(`[${category}] ${msg}\n`, "stderr"));

        } else if (typeof this.config !== "undefined" && this.config.verbose === true) {
            this.sendEvent(new OutputEvent(`[${category}] ${msg}\n`));
        }
    }

    private waitForConfiguration() {
        return new Promise<void>(resolve => { this.onConfigurationDone = resolve; });
    }
}
