export interface CompilerSettings {
    executablePath: string;
    includePaths: string[];
    options: string[];
    outputType: string;
    outputPath: string;
    showInfoMessages: boolean;
    reformatOutput: boolean;
    switchToOutput: boolean;
};

export interface LanguageSettings {
    reparseInterval: number;
    webApiLinks: boolean;
    enableDocumentLinks: boolean;
    enableGoToDefinition: boolean;
    enableReferences: boolean;
    enableCodeLensReferences: boolean;
    enableInlayHints: boolean;
    enableSignatureHelp: boolean;
    enableHover: boolean;
    enableCompletions: boolean;
    enableDocumentSymbols: boolean;
    enableDocumentFormatting: boolean;
    enableOnTypeFormatting: boolean;
    enableSemanticMacros: boolean;
};

export interface SyncedSettings {
    compiler: CompilerSettings;
    language: LanguageSettings;
}
