import * as vscode from "vscode";
import * as Net from "net";
import * as path from "path";
import {LuaDebugSession} from "./luaDebugSession";
import {LaunchConfig} from "./launchConfig";

const enableServer = true;
const debuggerType = "wow-lua-error-loader";

function abortLaunch(message: string) {
    void vscode.window.showErrorMessage(message);
    // tslint:disable-next-line:no-null-keyword
    return null;
}

const configurationProvider: vscode.DebugConfigurationProvider = {
    resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration & Partial<LaunchConfig>,
        token?: vscode.CancellationToken
    ): vscode.DebugConfiguration | null | undefined {
        //Validate config
        config.type = debuggerType;

        //Pass paths to debugger
        if (typeof folder !== "undefined") {
            config.workspacePath = folder.uri.fsPath;
        } else if (typeof vscode.window.activeTextEditor !== "undefined") {
            config.workspacePath = path.dirname(vscode.window.activeTextEditor.document.uri.fsPath);
        } else {
            return abortLaunch("No path for debugger");
        }

        const extension = vscode.extensions.getExtension("Sapu94.wow-lua-error-loader");
        if (typeof extension === "undefined") {
            return abortLaunch("Failed to find extension path");
        }
        config.extensionPath = extension.extensionPath;
        config.cwd = config.workspacePath;

        return config;
    }
};

let debugAdapaterDescriptorFactory: (vscode.DebugAdapterDescriptorFactory & { dispose: () => void }) | undefined;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
if (enableServer) {
    let server: Net.Server | null = null;

    debugAdapaterDescriptorFactory = {
        createDebugAdapterDescriptor(
            session: vscode.DebugSession,
            executable: vscode.DebugAdapterExecutable | undefined
        ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
            if (server === null) {
                server = Net.createServer(socket => {
                    const debugSession = new LuaDebugSession();
                    debugSession.setRunAsServer(true);
                    debugSession.start(socket as NodeJS.ReadableStream, socket);
                }).listen(0);
            }
            return new vscode.DebugAdapterServer((server.address() as Net.AddressInfo).port);
        },

        dispose() {
            if (server !== null) {
                server.close();
                server = null;
            }
        }
    };
}

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(debuggerType, configurationProvider)
    );

    if (typeof debugAdapaterDescriptorFactory !== "undefined") {
        context.subscriptions.push(
            vscode.debug.registerDebugAdapterDescriptorFactory(debuggerType, debugAdapaterDescriptorFactory)
        );
        context.subscriptions.push(debugAdapaterDescriptorFactory);
    }
}

export function deactivate(): void {
}
