'use strict';

import * as FS from 'fs';
import * as Path from 'path';

import {
  createConnection,
  IPCMessageReader,
  IPCMessageWriter,
  TextDocuments,
  TextDocumentSyncKind,
  DocumentLink,
  Location,
  CodeLens,
  Command,
  InlayHint,
  InlayHintKind,
  SemanticTokensBuilder,
  TextEdit,
  SymbolInformation,
  SymbolKind,
  Diagnostic,
  DiagnosticSeverity
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { URI } from 'vscode-uri';
import * as Settings from '../common/settings-types'; 
import * as Parser from './parser';
import * as Types from './types';
import * as DM from './dependency-manager';
import * as Helpers from './helpers';
import {resolvePathVariables} from '../common/helpers';
import {amxxDefaultHeaders} from './amxx-default-headers';

let syncedSettings: Settings.SyncedSettings;
let dependencyManager: DM.FileDependencyManager = new DM.FileDependencyManager();
let documentsData: WeakMap<TextDocument, Types.DocumentData> = new WeakMap();
let dependenciesData: WeakMap<DM.FileDependency, Types.DocumentData> = new WeakMap();
let workspaceRoot: string = '';
let supportsCodeLensRefresh: boolean = false;
const defaultSettings: Settings.SyncedSettings = {
    compiler: {
        executablePath: '',
        includePaths: [],
        options: [],
        outputType: 'source',
        outputPath: '',
        showInfoMessages: false,
        reformatOutput: true,
        switchToOutput: true
    },
    language: {
        reparseInterval: 1500,
        webApiLinks: false,
        enableDocumentLinks: true,
        enableGoToDefinition: true,
        enableReferences: true,
        enableCodeLensReferences: true,
        enableInlayHints: true,
        enableSignatureHelp: true,
        enableHover: true,
        enableCompletions: true,
        enableDocumentSymbols: true,
        enableDocumentFormatting: true,
        enableOnTypeFormatting: true,
        enableSemanticMacros: true
    }
};

/**
 * In future switch to incremental sync
 */
const connection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
const documentsManager = new TextDocuments(TextDocument);

documentsManager.listen(connection);
connection.listen();

connection.onInitialize((params) => {
    workspaceRoot =
        params.rootUri ??
        (params.workspaceFolders && params.workspaceFolders.length > 0
        ? params.workspaceFolders[0].uri
        : '');
    syncedSettings = defaultSettings;
    supportsCodeLensRefresh = !!params.capabilities.workspace?.codeLens?.refreshSupport;

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            documentLinkProvider: {
               resolveProvider: false 
            },
            definitionProvider: true,
            signatureHelpProvider: {
                triggerCharacters: ['(', ',']
            },
            documentSymbolProvider: true,
            completionProvider: {
                resolveProvider: false,
                triggerCharacters: ['(', ',', '=', '@']
            },
            hoverProvider: true,
            referencesProvider: true,
            codeLensProvider: {
                resolveProvider: false
            },
            inlayHintProvider: {
                resolveProvider: false
            },
            documentFormattingProvider: true,
            documentOnTypeFormattingProvider: {
                firstTriggerCharacter: '\n',
                moreTriggerCharacter: ['}']
            },
            semanticTokensProvider: {
                legend: {
                    tokenTypes: ['macro'],
                    tokenModifiers: []
                },
                full: true
            }
        }
    };
});

connection.onDocumentLinks((params) => {
    function inclusionsToLinks(inclusions: Types.InclusionDescriptor[]): DocumentLink[] {
        const links: DocumentLink[] = [];

        inclusions.forEach((inclusion) => {
            let filename = inclusion.filename;
            if(filename.substring(filename.length - 4) === '.inc') { // Remove .inc before checking
                filename = filename.substring(0, filename.length - 4);
            }
            if(amxxDefaultHeaders.indexOf(filename) >= 0) {
                links.push({
                    target: `https://amxmodx.org/api/${filename}`,
                    range: {
                        start: inclusion.start,
                        end: inclusion.end
                    }
                });
            }
        });

        return links;
    }

    if (!syncedSettings.language.enableDocumentLinks) {
        return null;
    }

    if(syncedSettings.language.webApiLinks === true) {
        const data = documentsData.get(documentsManager.get(params.textDocument.uri));
        
        return inclusionsToLinks(data.resolvedInclusions.map((inclusion) => inclusion.descriptor));
    }
    
    return null;
});

connection.onDidChangeConfiguration((params) => {
    const workspacePath = URI.parse(workspaceRoot).fsPath;

    const incoming = params.settings.amxxpawn as Settings.SyncedSettings | undefined;
    syncedSettings = incoming ?? defaultSettings;
    syncedSettings.language = {
        ...defaultSettings.language,
        ...(syncedSettings.language ?? {})
    };
    syncedSettings.compiler = {
        ...defaultSettings.compiler,
        ...(syncedSettings.compiler ?? {})
    };

    const includePaths = syncedSettings.compiler.includePaths || [];

    syncedSettings.compiler.includePaths = includePaths.length > 0
        ? includePaths.map(p =>
            resolveIncludePathWithWorkspaceFallback(p, workspacePath)
        )
        : [Path.join(workspacePath, 'include')];

    documentsManager.all().forEach(reparseDocument);
});

connection.onDefinition((params) => {
    function inclusionLocation(inclusions: Types.ResolvedInclusion[]): Location {
        for(const inc of inclusions) {
            if( params.position.line === inc.descriptor.start.line
                && params.position.character > inc.descriptor.start.character
                && params.position.character < inc.descriptor.end.character
            ) {
                return Location.create(inc.uri, {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 1 }
                });
            }
        }

        return null;
    };

    if (!syncedSettings.language.enableGoToDefinition) {
        return null;
    }

    const document = documentsManager.get(params.textDocument.uri);
    if(document === undefined) {
        return null;
    }

    const data = documentsData.get(document);
    const location = inclusionLocation(data.resolvedInclusions);
    if(location !== null) {
        return location;
    }

    const identifier = Parser.getIdentifierForReferences(document.getText(), params.position);
    if (identifier.length > 0) {
        const isOnCallableDecl = data.callables.some((clb) => (
            clb.identifier === identifier &&
            clb.start.line === params.position.line &&
            params.position.character >= clb.start.character &&
            params.position.character <= clb.end.character
        ));
        if (isOnCallableDecl) {
            const refs = collectReferencesForIdentifier(identifier, data);
            const callable = data.callables.find((clb) => (
                clb.identifier === identifier &&
                clb.start.line === params.position.line &&
                params.position.character >= clb.start.character &&
                params.position.character <= clb.end.character
            ));
            const filtered = callable ? refs.filter((loc) => !isSameLocation(loc, callable)) : refs;
            if (filtered.length === 1) {
                return filtered[0];
            }
            return filtered;
        }
    }

    return Parser.doDefinition(document.getText(), params.position, data, dependenciesData);
});

connection.onSignatureHelp((params) => {
    if (!syncedSettings.language.enableSignatureHelp) {
        return null;
    }

    const document = documentsManager.get(params.textDocument.uri);
    if(document === undefined) {
        return null;
    }

    const data = documentsData.get(document);
    return Parser.doSignatures(document.getText(), params.position, Helpers.getSymbols(data, dependenciesData).callables);
});

connection.onDocumentSymbol((params) => {
    if (!syncedSettings.language.enableDocumentSymbols) {
        return [];
    }

    const data = documentsData.get(documentsManager.get(params.textDocument.uri));

    const symbols: SymbolInformation[] = data.callables.map<SymbolInformation>((clb) => ({
        name: clb.identifier,
        location: {
            range: {
                start: clb.start,
                end: clb.end
            },
            uri: params.textDocument.uri
        },
        kind: SymbolKind.Function
    }));

    return symbols;
});

connection.onCompletion((params) => {
    if (!syncedSettings.language.enableCompletions) {
        return {
            isIncomplete: false,
            items: []
        };
    }

    const document = documentsManager.get(params.textDocument.uri);
    if(document === undefined) {
        return null;
    }

    const data = documentsData.get(document);
    return {
        isIncomplete: true,
        items: Parser.doCompletions(document.getText(), params.position, data, dependenciesData)
    };
});

connection.onHover((params) => {
    if (!syncedSettings.language.enableHover) {
        return null;
    }

    const document = documentsManager.get(params.textDocument.uri);
    if(document === undefined) {
        return null;
    }

    const data = documentsData.get(document);
    return Parser.doHover(document.getText(), params.position, data, dependenciesData);
});

connection.onReferences((params) => {
  if (!syncedSettings.language.enableReferences) {
    return [];
  }

  const document = documentsManager.get(params.textDocument.uri);
  if (document === undefined) {
    return [];
  }

  const data = documentsData.get(document);
  if (data === undefined) {
    return [];
  }

  const identifier = Parser.getIdentifierForReferences(document.getText(), params.position);
  return collectReferencesForIdentifier(identifier, data);
});

connection.onCodeLens((params) => {
    if (!syncedSettings.language.enableCodeLensReferences) {
        return [];
    }

    const document = documentsManager.get(params.textDocument.uri);
    if (document === undefined) {
        return [];
    }

    const data = documentsData.get(document);
    if (data === undefined) {
        return [];
    }

    const openDocs = documentsManager.all();
    const openDocsMap = new Map(openDocs.map((doc) => [doc.uri, doc]));
    const openContents = new Map<string, string>();
    openDocs.forEach((doc) => openContents.set(doc.uri, doc.getText()));

    const lenses: CodeLens[] = [];

    data.callables.forEach((clb) => {
        const allRefs = collectReferencesForIdentifier(clb.identifier, data, openDocsMap, openContents);
        const refs = allRefs.filter((loc) => loc.range.start.line !== clb.start.line);
        const refCount = refs.length;

        let title = `${refCount} references`;
        if (refCount === 1) {
            const snippet = getLineSnippet(refs[0], openDocsMap, openContents);
            if (snippet) {
                title = snippet;
            }
        }

        let command: Command;
        if (refCount === 1) {
            command = {
                title,
                command: 'amxxpawn.openLocation',
                arguments: [refs[0].uri, refs[0].range.start.line, refs[0].range.start.character]
            };
        } else {
            command = {
                title,
                command: 'amxxpawn.showReferences',
                arguments: [params.textDocument.uri, clb.start.line, clb.start.character, refs]
            };
        }

        lenses.push({
            range: {
                start: { line: clb.start.line, character: 0 },
                end: { line: clb.start.line, character: 0 }
            },
            command
        });
    });

    return lenses;
});

const inlayHintFeature = connection.languages && connection.languages.inlayHint;
if (inlayHintFeature) {
    inlayHintFeature.on((params) => {
        try {
            if (!syncedSettings.language.enableInlayHints) {
                return [];
            }

            const document = documentsManager.get(params.textDocument.uri);
            if (document === undefined) {
                return [];
            }

            const data = documentsData.get(document);
            if (data === undefined) {
                return [];
            }

            return collectInlayHints(document, data);
        } catch (err) {
            connection.console.error(`InlayHints error: ${String(err)}`);
            return [];
        }
    });
}

const semanticTokensFeature = connection.languages && connection.languages.semanticTokens;
if (semanticTokensFeature) {
    semanticTokensFeature.on((params) => {
        try {
            if (!syncedSettings.language.enableSemanticMacros) {
                return new SemanticTokensBuilder().build();
            }

            const document = documentsManager.get(params.textDocument.uri);
            if (document === undefined) {
                return new SemanticTokensBuilder().build();
            }

            const data = documentsData.get(document);
            if (data === undefined) {
                return new SemanticTokensBuilder().build();
            }

            return collectMacroSemanticTokens(document, data);
        } catch (err) {
            connection.console.error(`SemanticTokens error: ${String(err)}`);
            return new SemanticTokensBuilder().build();
        }
    });
}

connection.onDocumentFormatting((params) => {
    if (!syncedSettings.language.enableDocumentFormatting) {
        return [];
    }

    const document = documentsManager.get(params.textDocument.uri);
    if (document === undefined) {
        return [];
    }

    return formatDocumentIndentation(document);
});

connection.onDocumentOnTypeFormatting((params) => {
    if (!syncedSettings.language.enableOnTypeFormatting) {
        return [];
    }

    const document = documentsManager.get(params.textDocument.uri);
    if (document === undefined) {
        return [];
    }

    return formatLineIndentation(document, params.position.line);
});

function collectReferencesForIdentifier(
  identifier: string,
  data: Types.DocumentData,
  openDocsMap?: Map<string, TextDocument>,
  openContents?: Map<string, string>
): Location[] {
  if (!identifier) {
    return [];
  }

  const symbols = Helpers.getSymbols(data, dependenciesData);
  const callableIdx = symbols.callables.map((c) => c.identifier).indexOf(identifier);
  const finalIdent = callableIdx >= 0 ? symbols.callables[callableIdx].identifier : identifier;

  const openDocs = documentsManager.all();
  const localOpenDocsMap = openDocsMap ?? new Map(openDocs.map((doc) => [doc.uri, doc]));
  const localOpenContents = openContents ?? new Map(openDocs.map((doc) => [doc.uri, doc.getText()]));

  const uris = new Set<string>();
  openDocs.forEach((doc) => uris.add(doc.uri));

  const stack = [...data.dependencies];
  while (stack.length > 0) {
    const dep = stack.pop();
    if (dep === undefined || uris.has(dep.uri)) {
      continue;
    }
    uris.add(dep.uri);
    const depData = dependenciesData.get(dep);
    if (depData !== undefined) {
      stack.push(...depData.dependencies);
    }
  }

  const results: Location[] = [];
  const seen = new Set<string>();
  uris.forEach((uri) => {
    let content = '';
    const cached = localOpenContents.get(uri);
    if (cached !== undefined) {
        content = cached;
    } else {
        const openDoc = localOpenDocsMap.get(uri);
        if (openDoc !== undefined) {
            content = openDoc.getText();
        } else {
            try {
                content = FS.readFileSync(URI.parse(uri).fsPath).toString();
            } catch (err) {
                return;
            }
        }
        localOpenContents.set(uri, content);
    }

    const refs = Helpers.findReferencesInDocument(uri, content, finalIdent);
    refs.forEach((loc) => {
      const key = `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}:${loc.range.end.line}:${loc.range.end.character}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      results.push(loc);
    });
  });

  return results;
}

function isSameLocation(loc: Location, callable: Types.CallableDescriptor): boolean {
    if (loc.uri !== callable.file.toString()) {
        return false;
    }
    if (loc.range.start.line === callable.start.line) {
        return true;
    }
    return (
        loc.range.start.line === callable.start.line &&
        loc.range.start.character === callable.start.character &&
        loc.range.end.line === callable.end.line &&
        loc.range.end.character === callable.end.character
    );
}

function getLineSnippet(
  location: Location,
  openDocsMap: Map<string, TextDocument>,
  openContents: Map<string, string>
): string | null {
  let content = openContents.get(location.uri);
  if (content === undefined) {
    const openDoc = openDocsMap.get(location.uri);
    if (openDoc !== undefined) {
      content = openDoc.getText();
    } else {
      try {
        content = FS.readFileSync(URI.parse(location.uri).fsPath).toString();
      } catch (err) {
        return null;
      }
    }
    openContents.set(location.uri, content);
  }

  const line = content.split(/\r?\n/)[location.range.start.line];
  if (!line) {
    return null;
  }

  const trimmed = line.trim();
  return trimmed.length > 120 ? `${trimmed.substring(0, 117)}...` : trimmed;
}

function collectInlayHints(document: TextDocument, data: Types.DocumentData): InlayHint[] {
    const symbols = Helpers.getSymbols(data, dependenciesData);
    const paramMap = new Map<string, { names: string[]; hasVariadic: boolean }[]>();
    symbols.callables.forEach((clb) => {
        const labels = clb.parameters.map((p) => (p.label as string) ?? '');
        const names = labels.map((label) => getParamName(label)).filter((n) => n.length > 0);
        const hasVariadic = labels.some((label) => label.indexOf('...') >= 0);
        if (names.length > 0 || hasVariadic) {
            const existing = paramMap.get(clb.identifier);
            if (existing) {
                existing.push({ names, hasVariadic });
            } else {
                paramMap.set(clb.identifier, [{ names, hasVariadic }]);
            }
        }
    });

    const defineValues = new Map<string, string>();
    symbols.values.forEach((val) => {
        if (!val.isConst) {
            return;
        }
        if (!val.label.startsWith('#define ')) {
            return;
        }
        const parts = val.label.split(/\s+/);
        if (parts.length < 3) {
            return;
        }
        const value = parts.slice(2).join(' ');
        if (value.length > 0 && isSimpleDefineValue(value)) {
            defineValues.set(val.identifier, value);
        }
    });

    const text = document.getText();
    const declRanges = buildCallableDeclarationRanges(text, data);
    const hints: InlayHint[] = [];

    let i = 0;
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    while (i < text.length) {
        const ch = text[i];
        if (inLineComment) {
            if (ch === '\n') {
                inLineComment = false;
            }
            i++;
            continue;
        }
        if (inBlockComment) {
            if (ch === '*' && text[i + 1] === '/') {
                inBlockComment = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (inString) {
            if (ch === '"' && !isEscapedQuote(text, i)) {
                inString = false;
            }
            i++;
            continue;
        }
        if (ch === '/' && text[i + 1] === '/') {
            inLineComment = true;
            i += 2;
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            inBlockComment = true;
            i += 2;
            continue;
        }
        if (ch === '"' && !isEscapedQuote(text, i)) {
            inString = true;
            i++;
            continue;
        }

        if (!isIdentStart(ch) || (i > 0 && isIdentChar(text[i - 1]))) {
            i++;
            continue;
        }

        const identStart = i;
        i++;
        while (i < text.length && isIdentChar(text[i])) {
            i++;
        }
        const ident = text.substring(identStart, i);
        let paramOptions = paramMap.get(ident);
        if (!paramOptions) {
            const alias = resolveCallableAlias(ident);
            if (alias) {
                paramOptions = paramMap.get(alias);
            }
        }
        if (!paramOptions || paramOptions.length === 0) {
            continue;
        }

        while (i < text.length && /\s/.test(text[i])) {
            i++;
        }
        if (i >= text.length || text[i] !== '(') {
            continue;
        }

        const startPos = document.positionAt(identStart);
        if (isWithinDeclarationRange(startPos.line, startPos.character, declRanges)) {
            i++;
            continue;
        }

        const openParenIndex = i;
        const parsed = parseCallArguments(text, openParenIndex);
        if (!parsed) {
            i++;
            continue;
        }

        const args = parsed.args;
        const params = chooseParamNames(paramOptions, args);
        if (!params) {
            i = parsed.nextIndex;
            continue;
        }

        const used = new Set<string>();
        for (let idx = 0; idx < args.length; idx++) {
            const arg = args[idx];
            if (arg.namedParam) {
                if (params.indexOf(arg.namedParam) >= 0) {
                    used.add(arg.namedParam);
                }
                continue;
            }
            const nextParam = nextAvailableParam(params, used);
            if (!nextParam) {
                break;
            }
            used.add(nextParam);
            hints.push({
                position: document.positionAt(arg.start),
                label: `${nextParam}:`,
                kind: InlayHintKind.Parameter,
                paddingLeft: true,
                paddingRight: true
            });
        }

        i = openParenIndex + 1;
    }

    hints.push(...collectDefineValueHints(document, defineValues));
    return hints;
}

function collectDefineValueHints(document: TextDocument, defineValues: Map<string, string>): InlayHint[] {
    if (defineValues.size === 0) {
        return [];
    }

    const text = document.getText();
    const hints: InlayHint[] = [];
    let i = 0;
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    let lineStart = 0;
    let lineIsDefine = false;

    while (i < text.length) {
        const ch = text[i];
        if (inLineComment) {
            if (ch === '\n') {
                inLineComment = false;
                lineStart = i + 1;
                lineIsDefine = isDefineLine(text, lineStart);
            }
            i++;
            continue;
        }
        if (inBlockComment) {
            if (ch === '*' && text[i + 1] === '/') {
                inBlockComment = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (inString) {
            if (ch === '"' && !isEscapedQuote(text, i)) {
                inString = false;
            }
            i++;
            continue;
        }
        if (ch === '/' && text[i + 1] === '/') {
            inLineComment = true;
            i += 2;
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            inBlockComment = true;
            i += 2;
            continue;
        }
        if (ch === '"' && !isEscapedQuote(text, i)) {
            inString = true;
            i++;
            continue;
        }
        if (ch === '\n') {
            lineStart = i + 1;
            lineIsDefine = isDefineLine(text, lineStart);
            i++;
            continue;
        }

        if (lineIsDefine) {
            i++;
            continue;
        }

        if (isIdentStart(ch) && (i === 0 || !isIdentChar(text[i - 1]))) {
            const start = i;
            i++;
            while (i < text.length && isIdentChar(text[i])) {
                i++;
            }
            const ident = text.substring(start, i);
            const value = defineValues.get(ident);
            if (value) {
                const pos = document.positionAt(start + ident.length);
                hints.push({
                    position: pos,
                    label: `= ${value}`,
                    paddingLeft: true,
                    paddingRight: false
                });
            }
            continue;
        }

        i++;
    }

    return hints;
}

function formatDocumentIndentation(document: TextDocument): TextEdit[] {
    const lines = document.getText().split(/\r?\n/);
    const indents = computeIndentLevels(document.getText());
    const edits: TextEdit[] = [];

    for (let i = 0; i < lines.length; i++) {
        const desired = buildIndentString(indents[i] ?? 0);
        const current = lines[i].match(/^\s*/)?.[0] ?? '';
        if (current === desired) {
            continue;
        }
        edits.push(TextEdit.replace(
            {
                start: { line: i, character: 0 },
                end: { line: i, character: current.length }
            },
            desired
        ));
    }

    return edits;
}

function formatLineIndentation(document: TextDocument, lineIndex: number): TextEdit[] {
    const lines = document.getText().split(/\r?\n/);
    if (lineIndex < 0 || lineIndex >= lines.length) {
        return [];
    }

    const indents = computeIndentLevels(document.getText());
    let desiredLevel = indents[lineIndex] ?? 0;
    if (lineIndex > 0) {
        const prev = (lines[lineIndex - 1] ?? '').trim();
        if (/^(return|break|continue)\b/.test(prev)) {
            desiredLevel = Math.max(0, desiredLevel - 1);
        }
    }
    const desired = buildIndentString(desiredLevel);
    const current = lines[lineIndex].match(/^\s*/)?.[0] ?? '';
    if (current === desired) {
        return [];
    }

    return [TextEdit.replace(
        {
            start: { line: lineIndex, character: 0 },
            end: { line: lineIndex, character: current.length }
        },
        desired
    )];
}

function computeIndentLevels(content: string): number[] {
    const depths: number[] = [];
    let depth = 0;
    let line = 0;
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    depths[0] = 0;

    for (let i = 0; i < content.length; i++) {
        const ch = content[i];
        const next = content[i + 1];

        if (inLineComment) {
            if (ch === '\n') {
                inLineComment = false;
                line++;
                depths[line] = depth;
            }
            continue;
        }
        if (inBlockComment) {
            if (ch === '*' && next === '/') {
                inBlockComment = false;
                i++;
            }
            continue;
        }
        if (inString) {
            if (ch === '"' && !isEscapedQuote(content, i)) {
                inString = false;
            }
            if (ch === '\n') {
                line++;
                depths[line] = depth;
            }
            continue;
        }

        if (ch === '/' && next === '/') {
            inLineComment = true;
            i++;
            continue;
        }
        if (ch === '/' && next === '*') {
            inBlockComment = true;
            i++;
            continue;
        }
        if (ch === '"' && !isEscapedQuote(content, i)) {
            inString = true;
            continue;
        }

        if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth = Math.max(0, depth - 1);
        }

        if (ch === '\n') {
            line++;
            depths[line] = depth;
        }
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimStart();
        if (trimmed.startsWith('}')) {
            depths[i] = Math.max(0, (depths[i] ?? 0) - 1);
        }
    }

    return depths;
}

function buildIndentString(level: number): string {
    const size = 4;
    return ' '.repeat(Math.max(0, level) * size);
}

function isDefineLine(text: string, lineStart: number): boolean {
    let i = lineStart;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
        i++;
    }
    return text[i] === '#' && text.substring(i + 1, i + 7) === 'define';
}

function isSimpleDefineValue(value: string): boolean {
    const text = value.trim();
    if (text.length === 0) {
        return false;
    }
    if (/^0x[0-9a-fA-F]+$/.test(text)) {
        return true;
    }
    if (/^\d+$/.test(text)) {
        return true;
    }
    if (/^"[^"]*"$/.test(text)) {
        return true;
    }
    return false;
}

function collectMacroSemanticTokens(document: TextDocument, data: Types.DocumentData) {
    const symbols = Helpers.getSymbols(data, dependenciesData);
    const macros = new Set(symbols.callables.filter((c) => c.isMacro === true).map((c) => c.identifier));
    const builder = new SemanticTokensBuilder();
    if (macros.size === 0) {
        return builder.build();
    }

    const text = document.getText();
    let i = 0;
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;

    while (i < text.length) {
        const ch = text[i];
        if (inLineComment) {
            if (ch === '\n') {
                inLineComment = false;
            }
            i++;
            continue;
        }
        if (inBlockComment) {
            if (ch === '*' && text[i + 1] === '/') {
                inBlockComment = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (inString) {
            if (ch === '"' && !isEscapedQuote(text, i)) {
                inString = false;
            }
            i++;
            continue;
        }
        if (ch === '/' && text[i + 1] === '/') {
            inLineComment = true;
            i += 2;
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            inBlockComment = true;
            i += 2;
            continue;
        }
        if (ch === '"' && !isEscapedQuote(text, i)) {
            inString = true;
            i++;
            continue;
        }

        if (!isIdentStart(ch) || (i > 0 && isIdentChar(text[i - 1]))) {
            i++;
            continue;
        }

        const identStart = i;
        i++;
        while (i < text.length && isIdentChar(text[i])) {
            i++;
        }
        const ident = text.substring(identStart, i);
        if (macros.has(ident)) {
            const pos = document.positionAt(identStart);
            builder.push(pos.line, pos.character, ident.length, 0, 0);
        }
    }

    return builder.build();
}

function buildCallableDeclarationRanges(
    text: string,
    data: Types.DocumentData
): Map<number, { start: number; end: number }[]> {
    const lines = text.split(/\r?\n/);
    const declRanges = new Map<number, { start: number; end: number }[]>();

    data.callables.forEach((clb) => {
        const lineText = lines[clb.start.line];
        if (!lineText) {
            return;
        }
        const re = new RegExp(`\\b${escapeRegExp(clb.identifier)}\\b`);
        const m = re.exec(lineText);
        if (!m) {
            return;
        }
        const start = m.index;
        const end = start + clb.identifier.length;
        const list = declRanges.get(clb.start.line);
        if (list) {
            list.push({ start, end });
        } else {
            declRanges.set(clb.start.line, [{ start, end }]);
        }
    });

    return declRanges;
}

function isWithinDeclarationRange(
    line: number,
    character: number,
    declRanges: Map<number, { start: number; end: number }[]>
): boolean {
    const ranges = declRanges.get(line);
    if (!ranges) {
        return false;
    }
    return ranges.some((r) => character >= r.start && character <= r.end);
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseCallArguments(text: string, openParenIndex: number): { args: { start: number; namedParam?: string }[]; nextIndex: number } | null {
    let i = openParenIndex + 1;
    let depth = 0;
    let square = 0;
    let brace = 0;
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    const args: { start: number; namedParam?: string }[] = [];
    let expectArg = true;

    while (i < text.length) {
        const ch = text[i];

        if (inLineComment) {
            if (ch === '\n') {
                inLineComment = false;
            }
            i++;
            continue;
        }
        if (inBlockComment) {
            if (ch === '*' && text[i + 1] === '/') {
                inBlockComment = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (expectArg) {
            while (i < text.length && /\s/.test(text[i])) {
                i++;
            }
            if (i < text.length && text[i] === '/' && text[i + 1] === '/') {
                inLineComment = true;
                i += 2;
                continue;
            }
            if (i < text.length && text[i] === '/' && text[i + 1] === '*') {
                inBlockComment = true;
                i += 2;
                continue;
            }
            if (i < text.length && text[i] === ')') {
                return { args, nextIndex: i + 1 };
            }
            if (i < text.length && text[i] !== ')') {
                const namedParam = detectNamedArgument(text, i);
                args.push({ start: i, namedParam });
                expectArg = false;
            }
            continue;
        }

        if (ch === '"' && !isEscapedQuote(text, i)) {
            inString = !inString;
            i++;
            continue;
        }
        if (inString) {
            i++;
            continue;
        }

        if (ch === '/' && text[i + 1] === '/') {
            inLineComment = true;
            i += 2;
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            inBlockComment = true;
            i += 2;
            continue;
        }

        if (ch === '(') {
            depth++;
            i++;
            continue;
        }
        if (ch === ')') {
            if (depth === 0 && square === 0 && brace === 0) {
                return { args, nextIndex: i + 1 };
            }
            depth--;
            i++;
            continue;
        }
        if (ch === '[') {
            square++;
            i++;
            continue;
        }
        if (ch === ']') {
            square--;
            i++;
            continue;
        }
        if (ch === '{') {
            brace++;
            i++;
            continue;
        }
        if (ch === '}') {
            brace--;
            i++;
            continue;
        }

        if (ch === ',' && depth === 0 && square === 0 && brace === 0) {
            expectArg = true;
            i++;
            continue;
        }

        i++;
    }

    return null;
}

function detectNamedArgument(text: string, argStart: number): string | undefined {
    let i = argStart;
    if (text[i] === '.') {
        i++;
        if (!isIdentStart(text[i])) {
            return undefined;
        }
        const start = i;
        i++;
        while (i < text.length && isIdentChar(text[i])) {
            i++;
        }
        const name = text.substring(start, i);
        while (i < text.length && /\s/.test(text[i])) {
            i++;
        }
        if (text[i] === '=') {
            return name;
        }
    }
    if (isIdentStart(text[i])) {
        const start = i;
        i++;
        while (i < text.length && isIdentChar(text[i])) {
            i++;
        }
        const name = text.substring(start, i);
        while (i < text.length && /\s/.test(text[i])) {
            i++;
        }
        if (text[i] === ':') {
            return name;
        }
    }

    i = argStart;
    const maxScan = 200;
    let scanned = 0;
    let inString = false;
    let depth = 0;

    while (i < text.length && scanned < maxScan) {
        const ch = text[i];
        if (ch === '"' && !isEscapedQuote(text, i)) {
            inString = !inString;
            i++;
            scanned++;
            continue;
        }
        if (inString) {
            i++;
            scanned++;
            continue;
        }
        if (ch === '(') {
            depth++;
            i++;
            scanned++;
            continue;
        }
        if (ch === ')') {
            if (depth === 0) {
                return undefined;
            }
            depth--;
            i++;
            scanned++;
            continue;
        }
        if (ch === ',' && depth === 0) {
            return undefined;
        }
        if (ch === ':' && depth === 0) {
            i++;
            while (i < text.length && /\s/.test(text[i])) {
                i++;
            }
            if (i >= text.length || !isIdentStart(text[i])) {
                return undefined;
            }
            const start = i;
            i++;
            while (i < text.length && isIdentChar(text[i])) {
                i++;
            }
            return text.substring(start, i);
        }
        i++;
        scanned++;
    }

    return undefined;
}

function chooseParamNames(
    options: { names: string[]; hasVariadic: boolean }[],
    args: { start: number; namedParam?: string }[]
): string[] | undefined {
    let positionalCount = 0;
    for (const arg of args) {
        if (!arg.namedParam) {
            positionalCount++;
        }
    }

    let best: string[] | undefined;
    for (const params of options) {
        const names = params.names;
        let namedCount = 0;
        let ok = true;
        for (const arg of args) {
            if (!arg.namedParam) {
                continue;
            }
            if (names.indexOf(arg.namedParam) < 0) {
                // Treat unknown "named" args as positional (e.g., Float:1.0)
                continue;
            }
            namedCount++;
        }
        if (!ok) {
            continue;
        }

        const available = names.length - namedCount;
        if (positionalCount > available && params.hasVariadic !== true) {
            continue;
        }

        if (!best || names.length > best.length) {
            best = names;
        }
    }

    return best;
}

function nextAvailableParam(params: string[], used: Set<string>): string | undefined {
    for (const name of params) {
        if (!used.has(name)) {
            return name;
        }
    }
    return undefined;
}

function isIdentStart(ch: string): boolean {
    return /[A-Za-z_@]/.test(ch);
}

function isIdentChar(ch: string): boolean {
    return /[A-Za-z0-9_@]/.test(ch);
}

function isEscapedQuote(text: string, index: number): boolean {
    if (index <= 0) {
        return false;
    }
    const prev = text[index - 1];
    return prev === '\\' || prev === '^';
}

function getParamName(label: string): string {
    let text = label.trim();
    if (text.length === 0) {
        return '';
    }

    const eqIdx = text.indexOf('=');
    if (eqIdx >= 0) {
        text = text.substring(0, eqIdx).trim();
    }

    const tagIdx = text.lastIndexOf(':');
    if (tagIdx >= 0) {
        text = text.substring(tagIdx + 1).trim();
    }

    while (text.endsWith(']')) {
        const open = text.lastIndexOf('[');
        if (open < 0) {
            break;
        }
        text = text.substring(0, open).trim();
    }

    const match = text.match(/[A-Za-z_@][\w_@]*$/);
    return match ? match[0] : '';
}

function resolveCallableAlias(identifier: string): string | undefined {
    switch (identifier) {
        case 'fmt':
            return 'format';
        default:
            return undefined;
    }
}

documentsManager.onDidOpen((ev) => {
    let data = new Types.DocumentData(ev.document.uri);
    documentsData.set(ev.document, data);
    reparseDocument(ev.document);
});

documentsManager.onDidClose((ev) => {
    Helpers.removeDependencies(documentsData.get(ev.document).dependencies, dependencyManager, dependenciesData);
    Helpers.removeUnreachableDependencies(documentsManager.all().map((doc) => documentsData.get(doc)), dependencyManager, dependenciesData);
    documentsData.delete(ev.document);
});

documentsManager.onDidChangeContent((ev) => {
    let data = documentsData.get(ev.document);

    if(data.reparseTimer === null) {
        data.reparseTimer = setTimeout(reparseDocument, syncedSettings.language.reparseInterval, ev.document);
    }
    refreshCodeLens();
});


function resolveIncludePath(filename: string, localTo: string): string {
    const includePaths = [...syncedSettings.compiler.includePaths];
    // If should check the local path, check it first
    if(localTo !== undefined) {
        includePaths.unshift(localTo);
    }

    for(const includePath of includePaths) {
        let path = Path.join(includePath, filename);

        try {
            FS.accessSync(path, FS.constants.R_OK);
            return URI.file(path).toString();
        } catch(err) {
            // Append .inc and try again
            // amxxpc actually tries to append .p and .pawn in addition to .inc, but nobody uses those
            try {
                path += '.inc';
                FS.accessSync(path, FS.constants.R_OK);
                return URI.file(path).toString();
            } catch(err) {
                continue;
            }
        }
    }

    return undefined;
}

// Should probably move this to 'parser.ts'
function parseFile(fileUri: URI, content: string, data: Types.DocumentData, diagnostics: Map<string, Diagnostic[]>, isDependency: boolean) {
    let myDiagnostics = [];
    diagnostics.set(data.uri, myDiagnostics);
    // We are going to list all dependencies here first before we add them to data.dependencies
    // so we can check if any previous dependencies have been removed.
    const dependencies: DM.FileDependency[] = [];

    const results = Parser.parse(fileUri, content, isDependency);
    
    data.resolvedInclusions = [];
    myDiagnostics.push(...results.diagnostics);

    results.headerInclusions.forEach((header) => {
        const resolvedUri = resolveIncludePath(header.filename, header.isLocal ? Path.dirname(URI.parse(data.uri).fsPath) : undefined);
        if(resolvedUri === data.uri) {
            return;
        }

        if(resolvedUri !== undefined) { // File exists
            let dependency = dependencyManager.getDependency(resolvedUri);
            if(dependency === undefined) {
                // No other files depend on the included one
                dependency = dependencyManager.addReference(resolvedUri);
            } else if(data.dependencies.indexOf(dependency) < 0) {
                // The included file already has data, but the parsed file didn't depend on it before
                dependencyManager.addReference(dependency.uri);
            }
            dependencies.push(dependency);

            let depData = dependenciesData.get(dependency);
            if(depData === undefined) { // The dependency file has no data yet
                depData = new Types.DocumentData(dependency.uri);
                dependenciesData.set(dependency, depData);
                
                // This should probably be made asynchronous in the future as it probably
                // blocks the event loop for a considerable amount of time.
                const content = FS.readFileSync(URI.parse(dependency.uri).fsPath).toString();
                parseFile(URI.parse(dependency.uri), content, depData, diagnostics, true);
            }

            data.resolvedInclusions.push({
                uri: resolvedUri,
                descriptor: header
            });
        } else {
            myDiagnostics.push({
                message: `Couldn't resolve include path '${header.filename}'. Check compiler include paths.`,
                severity: header.isSilent ? DiagnosticSeverity.Information : DiagnosticSeverity.Error,
                source: 'amxxpawn',
                range: {
                    start: header.start,
                    end: header.end
                }
            });
        }
    });

    // Remove all dependencies that have been previously removed from the parsed document
    Helpers.removeDependencies(data.dependencies.filter((dep) => dependencies.indexOf(dep) < 0), dependencyManager, dependenciesData);
    data.dependencies = dependencies;

    data.callables = results.callables;
    data.values = results.values;
}

function reparseDocument(document: TextDocument) {
    const data = documentsData.get(document);
    if(data === undefined) {
        return;
    }
    data.reparseTimer = null;

    const diagnostics: Map<string, Diagnostic[]> = new Map();

    parseFile(URI.parse(document.uri), document.getText(), data, diagnostics, false);
    // Find and remove any dangling nodes in the dependency graph
    Helpers.removeUnreachableDependencies(documentsManager.all().map((doc) => documentsData.get(doc)), dependencyManager, dependenciesData);
    diagnostics.forEach((ds, uri) => connection.sendDiagnostics({ uri: uri, diagnostics: ds }));
    refreshCodeLens();
}

function refreshCodeLens() {
    if (!supportsCodeLensRefresh || !syncedSettings.language.enableCodeLensReferences) {
        return;
    }
    void connection.sendRequest('workspace/codeLens/refresh');
}

function resolveIncludePathWithWorkspaceFallback(
  inputPath: string | undefined,
  workspacePath: string
): string {
  // Default fallback: <workspace>/include
  if (!inputPath || inputPath.trim() === '') {
    return Path.join(workspacePath, 'include');
  }

  // Expand VSCode-style variables that may come through as raw strings
  const expanded = inputPath
    .replace(/\$\{workspaceFolder\}/g, workspacePath)
    .replace(/\$\{workspaceRoot\}/g, workspacePath);

  const resolved = resolvePathVariables(expanded, workspacePath, undefined);

  // Absolute path: respect it
  if (Path.isAbsolute(resolved)) {
    return resolved;
  }

  // Relative path: make it workspace-relative
  return Path.join(workspacePath, resolved);
}

