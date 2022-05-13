//MIT License
//
//Copyright (c) 2020 Tom Blind
//
//Permission is hereby granted, free of charge, to any person obtaining a copy
//of this software and associated documentation files (the "Software"), to deal
//in the Software without restriction, including without limitation the rights
//to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//copies of the Software, and to permit persons to whom the Software is
//furnished to do so, subject to the following conditions:
//
//The above copyright notice and this permission notice shall be included in all
//copies or substantial portions of the Software.
//
//THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//SOFTWARE.

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
import {CrashFile, CrashInfo} from "./crashfile";

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
        response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments
    ): void {
        this.showOutput("initializeRequest", OutputCategory.Request);

        if (typeof response.body === "undefined") {
            response.body = {};
        }

        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsTerminateRequest = true;

        this.sendResponse(response);

        this.sendEvent(new InitializedEvent());
    }

    protected configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
        args: DebugProtocol.ConfigurationDoneArguments
    ): void {
        this.showOutput("configurationDoneRequest", OutputCategory.Request);

        super.configurationDoneRequest(response, args);

        if (typeof this.onConfigurationDone !== "undefined") {
            this.onConfigurationDone();
        }
    }

    protected async launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: DebugProtocol.LaunchRequestArguments & LaunchConfig
    ): Promise<void> {
        this.config = args;

        this.showOutput("launchRequest", OutputCategory.Request);

        await this.waitForConfiguration();

        //Setup process
        if (!path.isAbsolute(this.config.cwd)) {
            this.config.cwd = path.resolve(this.config.workspacePath, this.config.cwd);
        }
        const cwd = this.config.cwd;
        this.crashInfo = (new CrashFile(cwd + "/" + this.config.crashFile)).parse();

        this.showOutput(`launching from "${cwd}"`, OutputCategory.Info);

        this.showOutput(this.crashInfo.errMsg, OutputCategory.Error);
        const evt: DebugProtocol.StoppedEvent = new StoppedEvent("exception", 1, this.crashInfo.errMsg);
        evt.body.allThreadsStopped = true;
        this.sendEvent(evt);

        for (const line of this.crashInfo.logLines) {
            this.showOutput(line, OutputCategory.Log);
        }

        this.sendResponse(response);
    }

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        this.showOutput("threadsRequest", OutputCategory.Request);
        // Just the main thread
        response.body = {
            threads: [
                {
                    id: 1,
                    name: "main thread"
                }
            ],
        };
        this.sendResponse(response);
    }

    protected async stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments
    ): Promise<void> {
        this.showOutput(`stackTraceRequest ${args.startFrame}/${args.levels} (thread ${args.threadId})`, OutputCategory.Request);

        if (!this.crashInfo) {
            response.success = false;
            this.sendResponse(response);
            return;
        }

        const startFrame = typeof args.startFrame !== "undefined" ? args.startFrame : 0;
        const maxLevels = typeof args.levels !== "undefined" ? args.levels : maxStackCount;
        const endFrame = Math.min(startFrame + maxLevels, this.crashInfo.frames.length);
        const frames: DebugProtocol.StackFrame[] = [];
        for (let i = startFrame; i < endFrame; ++i) {
            const info = this.crashInfo.frames[i];
            const currentLine = info.currentline;
            const separator = "/"; // FIXME

            let source: Source | undefined;
            let column = 1; //Needed for exception display: https://github.com/microsoft/vscode/issues/46080

            //Un-mapped source
            const sourceStr = info.source && info.source.replace(/[/\\]+/g, separator) || "?";
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
            let line = (currentLine && currentLine > 0) ? currentLine : -1;
            const stackFrame: DebugProtocol.StackFrame = new StackFrame(frameId, frameFunc, source, line, column);
            stackFrame.presentationHint = typeof sourcePath === "undefined" ? "subtle" : "normal";
            frames.push(stackFrame);
        }
        response.body = {stackFrames: frames, totalFrames: this.crashInfo.frames.length};
        this.sendResponse(response);
    }

    protected async scopesRequest(
        response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments
    ): Promise<void> {
        this.showOutput("scopesRequest", OutputCategory.Request);
        this.frame = args.frameId;
        const scopes: Scope[] = [
            new Scope("Locals", ScopeType.Local, false)
        ];
        response.body = {scopes};
        this.sendResponse(response);
    }

    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments
    ): Promise<void> {
        if (!this.crashInfo) {
            response.success = false;
            this.sendResponse(response);
            return;
        }

        const variables: Variable[] = [];
        if (args.variablesReference == ScopeType.Local) {
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
                    valueStr = "<table>"; // FIXME
                    indexedVariables = 0;
                    while (true) {
                        if ((value.val as any)[indexedVariables+1]) {
                            indexedVariables++;
                        } else {
                            break;
                        }
                    }
                    indexedVariables = indexedVariables > 0 ? indexedVariables + 1 : indexedVariables;
                } else if (value.type === "function") {
                    valueStr = "<function>"; // FIXME
                } else {
                    valueStr = `[${value.type}]`;
                }

                if (value.type === "table") {
                    const ref = this.variableHandles.create(`${this.frame}:${luaName}`);
                    variables.push(new Variable(luaName, valueStr, ref, indexedVariables, 1));
                } else {
                    variables.push(new Variable(luaName, valueStr, undefined, 0));
                }
            }
        } else {
            const ref = this.variableHandles.get(args.variablesReference);
            this.showOutput(`variablesRequest ${ref} ${args.filter} ${args.start}/${args.count}`, OutputCategory.Request);
            const parts = ref.split(":");
            if (parts.length < 2) {
                throw Error("Invalid ref");
            }
            const locals = this.crashInfo.frames[parseInt(parts[0])].locals;
            let tblVar = locals[parts[1]].val as any;
            for (let i = 2; i < parts.length; i++) {
                tblVar = tblVar[parts[i]];
            }
            if (args.filter === "named") {
                for (const key in tblVar) {
                    if (Number.isInteger(Number(key))) {
                        continue; // FIXME: support non-indexed, numeric keys
                    }
                    const value = tblVar[key];
                    let valueStr: string;
                    let indexedVariables: number | undefined;
                    if (typeof value === "string") {
                        valueStr = `"${value}"`;
                    } else if (typeof value === "number" || typeof value === "boolean") {
                        valueStr = `${value}`;
                    } else if (typeof value === "undefined") {
                        valueStr = "nil";
                    } else if (typeof value === "object") {
                        valueStr = "<table>"; // FIXME
                        indexedVariables = 0;
                        while (true) {
                            if (value[indexedVariables+1]) {
                                indexedVariables++;
                            } else {
                                break;
                            }
                        }
                        indexedVariables = indexedVariables > 0 ? indexedVariables + 1 : indexedVariables;
                    } else {
                        valueStr = `[${value.type}]`;
                    }
                    if (typeof value === "object") {
                        const newRef = this.variableHandles.create(`${ref}:${key}`);
                        variables.push(new Variable(key, valueStr, newRef, indexedVariables, 1));
                    } else {
                        variables.push(new Variable(key, valueStr, undefined, 0));
                    }
                }
            } else if (args.filter === "indexed") {
                if (typeof args.start === "undefined" || typeof args.count === "undefined") {
                    throw Error("Unhandled request");
                }
                const first = Math.max(args.start, 1);
                const last = args.start + args.count - 1;
                for (let i = first; i <= last; i++) {
                    const value = tblVar[i];
                    let valueStr: string;
                    let indexedVariables: number | undefined;
                    if (typeof value === "string") {
                        valueStr = `"${value}"`;
                    } else if (typeof value === "number" || typeof value === "boolean") {
                        valueStr = `${value}`;
                    } else if (typeof value === "undefined") {
                        valueStr = "nil";
                    } else if (typeof value === "object") {
                        valueStr = "<table>"; // FIXME
                        indexedVariables = 0;
                        while (true) {
                            if (value[indexedVariables+1]) {
                                indexedVariables++;
                            } else {
                                break;
                            }
                        }
                        indexedVariables = indexedVariables > 0 ? indexedVariables + 1 : indexedVariables;
                    } else {
                        valueStr = `[${value.type}]`;
                    }
                    if (typeof value === "object") {
                        const newRef = this.variableHandles.create(`${ref}:${i}`);
                        variables.push(new Variable(`${i}`, valueStr, newRef, indexedVariables, 1));
                    } else {
                        variables.push(new Variable(`${i}`, valueStr, undefined, 0));
                    }
                }
            } else if (typeof args.filter === "undefined") {
                for (const key in tblVar) {
                    const value = tblVar[key];
                    let valueStr: string;
                    let indexedVariables: number | undefined;
                    if (typeof value === "string") {
                        valueStr = `"${value}"`;
                    } else if (typeof value === "number" || typeof value === "boolean") {
                        valueStr = `${value}`;
                    } else if (typeof value === "undefined") {
                        valueStr = "nil";
                    } else if (typeof value === "object") {
                        valueStr = "<table>"; // FIXME
                        indexedVariables = 0;
                        while (true) {
                            if (value[indexedVariables+1]) {
                                indexedVariables++;
                            } else {
                                break;
                            }
                        }
                        indexedVariables = indexedVariables > 0 ? indexedVariables + 1 : indexedVariables;
                    } else {
                        valueStr = `[${value.type}]`;
                    }
                    if (typeof value === "object") {
                        const newRef = this.variableHandles.create(`${ref}:${key}`);
                        variables.push(new Variable(`${key}`, valueStr, newRef, indexedVariables, 1));
                    } else {
                        variables.push(new Variable(`${key}`, valueStr, undefined, 0));
                    }
                }
            } else {
                throw new Error(`Unexpected filter: ${args.filter}`);
            }
        }
        variables.sort(sortVariables);
        response.body = {variables};
        this.sendResponse(response);
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        this.showOutput("continueRequest", OutputCategory.Request);
        this.variableHandles.reset();
        this.sendResponse(response);
        this.sendEvent(new TerminatedEvent());
    }

    protected terminateRequest(
        response: DebugProtocol.TerminateResponse,
        args: DebugProtocol.TerminateArguments
    ): void {
        this.showOutput("terminateRequest", OutputCategory.Request);
        this.sendResponse(response);
        this.sendEvent(new TerminatedEvent());
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
