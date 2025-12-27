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
    enableInlayHintParameters: boolean;
    enableInlayHintConstValues: boolean;
    enableInlayHintConstValueStrings: boolean;
    enableSignatureHelp: boolean;
    enableHover: boolean;
    enableHoverConstValues: boolean;
    enableHoverDefineInlineComments: boolean;
    enableCompletions: boolean;
    enableDocumentSymbols: boolean;
    enableDocumentFormatting: boolean;
    enableOnTypeFormatting: boolean;
    enableSemanticMacros: boolean;
    enableSemanticEnumUsage: boolean;
};

export interface SyncedSettings {
    compiler: CompilerSettings;
    language: LanguageSettings;
}
