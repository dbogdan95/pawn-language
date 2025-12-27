'use strict';

import * as Path from 'path';
import * as VSC from 'vscode';

import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';

import * as Commands from './commands';

let diagnosticCollection: VSC.DiagnosticCollection;
let languageClient: LanguageClient | undefined;

export function activate(ctx: VSC.ExtensionContext) {
  const serverModulePath = ctx.asAbsolutePath(Path.join('build', 'server', 'server.js'));
  const debugOptions = { execArgv: ['--nolazy', '--inspect=5858'] };

  const serverOptions: ServerOptions = {
    run: {
      module: serverModulePath,
      transport: TransportKind.ipc,
      options: debugOptions
    },
    debug: {
      module: serverModulePath,
      transport: TransportKind.ipc,
      options: debugOptions
    }
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: 'amxxpawn' }],
    synchronize: {
      configurationSection: [
        'amxxpawn.language',
        'amxxpawn.compiler'
      ],
      fileEvents: VSC.workspace.createFileSystemWatcher('**/*.*')
    }
  };

  languageClient = new LanguageClient(
    'amxxpawn',
    'AMXXPawn Language Service',
    serverOptions,
    clientOptions
  );

  const outputChannel = VSC.window.createOutputChannel('AMXXPC Output / AMXXPawn');

  diagnosticCollection = VSC.languages.createDiagnosticCollection('amxxpawn');

  const commandCompile = VSC.commands.registerCommand(
    'amxxpawn.compile',
    Commands.compile.bind(null, outputChannel, diagnosticCollection)
  );

  const commandCompileLocal = VSC.commands.registerCommand(
    'amxxpawn.compileLocal',
    Commands.compileLocal.bind(null, outputChannel, diagnosticCollection)
  );

  const commandOpenLocation = VSC.commands.registerCommand(
    'amxxpawn.openLocation',
    async (uriString: string, line: number, character: number) => {
      const uri = VSC.Uri.parse(uriString);
      const doc = await VSC.workspace.openTextDocument(uri);
      const editor = await VSC.window.showTextDocument(doc, { preview: true });

      const pos = new VSC.Position(line, character);
      editor.selection = new VSC.Selection(pos, pos);
      editor.revealRange(new VSC.Range(pos, pos), VSC.TextEditorRevealType.InCenter);
    }
  );

  const commandShowReferences = VSC.commands.registerCommand(
    'amxxpawn.showReferences',
    async (uriString: string, line: number, character: number, locations: any[]) => {
      const uri = VSC.Uri.parse(uriString);
      const pos = new VSC.Position(line, character);
      const refs = (locations || []).map((loc) => {
        const luri = VSC.Uri.parse(loc.uri);
        const start = new VSC.Position(loc.range.start.line, loc.range.start.character);
        const end = new VSC.Position(loc.range.end.line, loc.range.end.character);
        return new VSC.Location(luri, new VSC.Range(start, end));
      });

      await VSC.commands.executeCommand('editor.action.showReferences', uri, pos, refs);
    }
  );

  VSC.workspace.onDidChangeTextDocument(onDidChangeTextDocument);

  ctx.subscriptions.push(
    diagnosticCollection,
    commandCompile,
    commandCompileLocal,
    outputChannel,
    commandOpenLocation,
    commandShowReferences
  );

  void languageClient.start();
}

function onDidChangeTextDocument(ev: VSC.TextDocumentChangeEvent) {
  diagnosticCollection.delete(ev.document.uri);
}

export async function deactivate() {
  if (languageClient) {
    await languageClient.stop();
  }
}
