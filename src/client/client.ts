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

  VSC.workspace.onDidChangeTextDocument(onDidChangeTextDocument);

  ctx.subscriptions.push(
    diagnosticCollection,
    commandCompile,
    commandCompileLocal,
    outputChannel
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
