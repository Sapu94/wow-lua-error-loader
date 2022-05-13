export interface LaunchConfig {
    extensionPath: string;
    workspacePath: string;
    cwd: string;
    verbose?: boolean;
    crashFile: string;
}
